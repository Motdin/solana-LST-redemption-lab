import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { toAtomic } from "./amount.js";
import { SOL_DECIMALS, WSOL_MINT } from "./config.js";

const MAX_STRATEGIES = 12;
const MAX_AMOUNTS_PER_STRATEGY = 12;
// Every candidate takes two Jupiter quotes: leg one and leg two.
const MAX_TOTAL_JUPITER_QUOTES = 64;
const MAX_DEXES_PER_LEG = 4;

/**
 * An observation-only, two-leg cycle that always borrows and repays WSOL.
 * The two DEX allowlists must be disjoint, so it cannot silently quote a
 * same-venue round trip that is guaranteed to lose fees.
 */
export type PairArbStrategy = {
  id: string;
  enabled: boolean;
  intermediateMint: PublicKey;
  legOneDexes: string[];
  legTwoDexes: string[];
  borrowAmountsRaw: bigint[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePublicKey(value: unknown, field: string): PublicKey {
  if (typeof value !== "string")
    throw new Error(`${field} must be a base58 public key string`);
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${field} is not a valid Solana public key`);
  }
}

function parseDexes(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty DEX-label array`);
  }
  if (value.length > MAX_DEXES_PER_LEG) {
    throw new Error(
      `${field} may have at most ${MAX_DEXES_PER_LEG} DEX labels`,
    );
  }

  const dexes = value.map((dex, index) => {
    if (typeof dex !== "string")
      throw new Error(`${field}[${index}] must be a DEX label string`);
    const normalized = dex.trim();
    if (!normalized || normalized.length > 64 || normalized.includes(",")) {
      throw new Error(
        `${field}[${index}] must be a non-empty DEX label without commas`,
      );
    }
    return normalized;
  });
  const normalizedDexes = dexes.map((dex) => dex.toLowerCase());
  if (new Set(normalizedDexes).size !== dexes.length) {
    throw new Error(`${field} contains duplicate DEX labels`);
  }
  return dexes;
}

function parseStrategy(value: unknown, index: number): PairArbStrategy {
  if (!isRecord(value))
    throw new Error(`strategies[${index}] must be an object`);
  const id = value.id;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-_]{0,47}$/i.test(id)) {
    throw new Error(
      `strategies[${index}].id must be 1-48 alphanumeric, hyphen, or underscore characters`,
    );
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`strategies[${index}].enabled must be boolean`);
  }
  if (
    !Array.isArray(value.borrowAmountsSol) ||
    value.borrowAmountsSol.length === 0
  ) {
    throw new Error(
      `strategies[${index}].borrowAmountsSol must be a non-empty array`,
    );
  }
  if (value.borrowAmountsSol.length > MAX_AMOUNTS_PER_STRATEGY) {
    throw new Error(
      `strategies[${index}] exceeds ${MAX_AMOUNTS_PER_STRATEGY} borrow amounts`,
    );
  }

  const intermediateMint = parsePublicKey(
    value.intermediateMint,
    `strategies[${index}].intermediateMint`,
  );
  if (intermediateMint.equals(WSOL_MINT)) {
    throw new Error(
      `strategies[${index}].intermediateMint must differ from the WSOL flash asset`,
    );
  }
  const legOneDexes = parseDexes(
    value.legOneDexes,
    `strategies[${index}].legOneDexes`,
  );
  const legTwoDexes = parseDexes(
    value.legTwoDexes,
    `strategies[${index}].legTwoDexes`,
  );
  const legOneSet = new Set(legOneDexes.map((dex) => dex.toLowerCase()));
  const overlap = legTwoDexes.find((dex) => legOneSet.has(dex.toLowerCase()));
  if (overlap) {
    throw new Error(
      `strategies[${index}] uses ${overlap} on both legs; venues must be disjoint`,
    );
  }

  const borrowAmountsRaw = value.borrowAmountsSol.map((amount, amountIndex) => {
    if (typeof amount !== "string") {
      throw new Error(
        `strategies[${index}].borrowAmountsSol[${amountIndex}] must be a decimal string`,
      );
    }
    const raw = toAtomic(amount, SOL_DECIMALS);
    if (raw === 0n) {
      throw new Error(
        `strategies[${index}].borrowAmountsSol[${amountIndex}] must be greater than zero`,
      );
    }
    return raw;
  });

  return {
    id,
    enabled: value.enabled ?? true,
    intermediateMint,
    legOneDexes,
    legTwoDexes,
    borrowAmountsRaw: [...new Set(borrowAmountsRaw)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  };
}

/** Parse a bounded, public allowlist of DEX-to-DEX observation routes. */
export function parsePairStrategies(value: unknown): PairArbStrategy[] {
  if (!isRecord(value) || !Array.isArray(value.strategies)) {
    throw new Error(
      'Pair strategy file must have a top-level "strategies" array',
    );
  }
  if (
    value.strategies.length === 0 ||
    value.strategies.length > MAX_STRATEGIES
  ) {
    throw new Error(
      `Pair strategy file must contain 1-${MAX_STRATEGIES} strategies`,
    );
  }

  const strategies = value.strategies.map(parseStrategy);
  const ids = new Set<string>();
  for (const strategy of strategies) {
    if (ids.has(strategy.id))
      throw new Error(`Duplicate pair strategy id: ${strategy.id}`);
    ids.add(strategy.id);
  }

  const enabledQuoteCount = strategies
    .filter((strategy) => strategy.enabled)
    .reduce(
      (total, strategy) => total + strategy.borrowAmountsRaw.length * 2,
      0,
    );
  if (enabledQuoteCount === 0)
    throw new Error("At least one pair strategy must be enabled");
  if (enabledQuoteCount > MAX_TOTAL_JUPITER_QUOTES) {
    throw new Error(
      `Enabled pair strategies exceed ${MAX_TOTAL_JUPITER_QUOTES} Jupiter quotes per scan`,
    );
  }
  return strategies;
}

export async function loadPairStrategies(
  filePath: string,
): Promise<PairArbStrategy[]> {
  const path = resolve(filePath);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not load PAIR_STRATEGIES_FILE (${path}): ${(error as Error).message}`,
    );
  }
  return parsePairStrategies(value);
}
