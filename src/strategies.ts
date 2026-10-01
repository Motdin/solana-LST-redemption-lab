import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { toAtomic } from "./amount.js";
import { SOL_DECIMALS } from "./config.js";

const MAX_STRATEGIES = 24;
const MAX_AMOUNTS_PER_STRATEGY = 16;
const MAX_TOTAL_QUOTES = 64;

export type FlashRedeemStrategy = {
  id: string;
  enabled: boolean;
  lstMint: PublicKey;
  stakePool: PublicKey;
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

function parseStrategy(value: unknown, index: number): FlashRedeemStrategy {
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

  const borrowAmountsRaw = value.borrowAmountsSol.map((amount, amountIndex) => {
    if (typeof amount !== "string") {
      throw new Error(
        `strategies[${index}].borrowAmountsSol[${amountIndex}] must be a decimal string`,
      );
    }
    const raw = toAtomic(amount, SOL_DECIMALS);
    if (raw === 0n)
      throw new Error(
        `strategies[${index}].borrowAmountsSol[${amountIndex}] must be greater than zero`,
      );
    return raw;
  });
  const uniqueAmounts = [...new Set(borrowAmountsRaw)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return {
    id,
    enabled: value.enabled ?? true,
    lstMint: parsePublicKey(value.lstMint, `strategies[${index}].lstMint`),
    stakePool: parsePublicKey(
      value.stakePool,
      `strategies[${index}].stakePool`,
    ),
    borrowAmountsRaw: uniqueAmounts,
  };
}

/** Parse a deliberately small, public whitelist; it never contains signing material. */
export function parseStrategies(value: unknown): FlashRedeemStrategy[] {
  if (!isRecord(value) || !Array.isArray(value.strategies)) {
    throw new Error('Strategy file must have a top-level "strategies" array');
  }
  if (
    value.strategies.length === 0 ||
    value.strategies.length > MAX_STRATEGIES
  ) {
    throw new Error(
      `Strategy file must contain 1-${MAX_STRATEGIES} strategies`,
    );
  }

  const strategies = value.strategies.map(parseStrategy);
  const ids = new Set<string>();
  const pools = new Set<string>();
  for (const strategy of strategies) {
    if (ids.has(strategy.id))
      throw new Error(`Duplicate strategy id: ${strategy.id}`);
    if (pools.has(strategy.stakePool.toBase58())) {
      throw new Error(
        `Duplicate stake pool in whitelist: ${strategy.stakePool.toBase58()}`,
      );
    }
    ids.add(strategy.id);
    pools.add(strategy.stakePool.toBase58());
  }

  const enabledQuotes = strategies
    .filter((strategy) => strategy.enabled)
    .reduce((total, strategy) => total + strategy.borrowAmountsRaw.length, 0);
  if (enabledQuotes === 0)
    throw new Error("At least one strategy must be enabled");
  if (enabledQuotes > MAX_TOTAL_QUOTES) {
    throw new Error(
      `Enabled strategies exceed ${MAX_TOTAL_QUOTES} quotes per scan`,
    );
  }
  return strategies;
}

export async function loadStrategies(
  filePath: string,
): Promise<FlashRedeemStrategy[]> {
  const path = resolve(filePath);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not load STRATEGIES_FILE (${path}): ${(error as Error).message}`,
    );
  }
  return parseStrategies(value);
}
