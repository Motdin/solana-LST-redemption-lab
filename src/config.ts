import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { toAtomic } from "./amount.js";

export const SOL_DECIMALS = 9;
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
export const MARGINFI_LST_MINT = new PublicKey(
  "LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp",
);
export const MARGINFI_STAKE_POOL = new PublicKey(
  "DqhH94PjkZsjAqEze2BEkWhFQJ6EyU6MdtMphMgnXqeK",
);

/** Global execution and pricing controls shared by every whitelisted strategy. */
export type BotConfig = {
  rpcUrl: string;
  keypairPath: string;
  kaminoLendingMarket: PublicKey;
  kaminoWsolReserve?: PublicKey;
  strategiesFile: string;
  /** Observation-only DEX cycle whitelist. It has no execution command. */
  pairStrategiesFile: string;
  jupiterApiBase: string;
  jupiterApiKey?: string;
  slippageBps: number;
  onlyDirectRoutes: boolean;
  maxQuoteAccounts?: number;
  strictJupiterValidation: boolean;
  maxFlashFeeBps: number;
  minNetProfitRaw: bigint;
  maxTxCostRaw: bigint;
  minGasBalanceRaw: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  pollMs: number;
  /** Slower default for a bounded but multi-quote public-API observer. */
  pairPollMs: number;
  /** Local-only destination for CSV and JSONL pair-observation records. */
  pairObservationLogDir: string;
  executionEnabled: boolean;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function asPublicKey(name: string, fallback?: PublicKey): PublicKey {
  const value = optional(name);
  if (!value && fallback) return fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} is not a valid Solana public key`);
  }
}

function bool(name: string, fallback: boolean): boolean {
  const value = optional(name);
  if (!value) return fallback;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function nonNegativeInteger(name: string, fallback: number, min = 0): number {
  const source = optional(name) ?? String(fallback);
  if (!/^\d+$/.test(source)) throw new Error(`${name} must be an integer`);
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer ≥ ${min}`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number, min = 1): number {
  return nonNegativeInteger(name, fallback, min);
}

function amount(name: string, fallback: string): bigint {
  return toAtomic(optional(name) ?? fallback, SOL_DECIMALS);
}

function normalizeJupiterUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("not https");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error(
      "JUPITER_API_BASE must be a valid HTTPS URL, e.g. https://lite-api.jup.ag/swap/v1",
    );
  }
}

/**
 * Secrets remain in a local JSON keypair file; this parser only reads paths and
 * public configuration. LST and observation-only pair whitelists live in JSON files.
 */
export function loadConfig(
  options: { requireKeypair?: boolean } = {},
): BotConfig {
  const network = optional("SOLANA_CLUSTER") ?? "mainnet-beta";
  if (network !== "mainnet-beta") {
    throw new Error(
      "This scanner is pinned to mainnet-beta because its configured strategies are mainnet-only",
    );
  }

  return {
    rpcUrl: required("RPC_URL"),
    // Pair observation has no signing path and intentionally does not need a
    // local keypair file. All other commands preserve the required keypair gate.
    keypairPath:
      options.requireKeypair === false
        ? (optional("KEYPAIR_PATH") ?? "")
        : required("KEYPAIR_PATH"),
    kaminoLendingMarket: asPublicKey("KAMINO_LENDING_MARKET"),
    kaminoWsolReserve: optional("KAMINO_WSOL_RESERVE")
      ? asPublicKey("KAMINO_WSOL_RESERVE")
      : undefined,
    strategiesFile: optional("STRATEGIES_FILE") ?? "./strategies.json",
    pairStrategiesFile:
      optional("PAIR_STRATEGIES_FILE") ?? "./pair-strategies.json",
    jupiterApiBase: normalizeJupiterUrl(
      optional("JUPITER_API_BASE") ?? "https://lite-api.jup.ag/swap/v1",
    ),
    jupiterApiKey: optional("JUPITER_API_KEY"),
    slippageBps: positiveInteger("SLIPPAGE_BPS", 25, 1),
    onlyDirectRoutes: bool("ONLY_DIRECT_ROUTES", true),
    maxQuoteAccounts: optional("MAX_QUOTE_ACCOUNTS")
      ? positiveInteger("MAX_QUOTE_ACCOUNTS", 40, 8)
      : 40,
    strictJupiterValidation: bool("STRICT_JUPITER_VALIDATION", true),
    maxFlashFeeBps: nonNegativeInteger("MAX_FLASH_FEE_BPS", 1),
    minNetProfitRaw: amount("MIN_NET_PROFIT_SOL", "0.01"),
    maxTxCostRaw: amount("MAX_TX_COST_SOL", "0.005"),
    minGasBalanceRaw: amount("MIN_GAS_BALANCE_SOL", "0.02"),
    computeUnitLimit: positiveInteger("COMPUTE_UNIT_LIMIT", 1_200_000, 100_000),
    computeUnitPriceMicroLamports: nonNegativeInteger(
      "COMPUTE_UNIT_PRICE_MICROLAMPORTS",
      10_000,
    ),
    pollMs: positiveInteger("POLL_MS", 5_000, 500),
    pairPollMs: positiveInteger("PAIR_POLL_MS", 300_000, 30_000),
    pairObservationLogDir:
      optional("PAIR_OBSERVATION_LOG_DIR") ?? "./logs/pair-observations",
    executionEnabled: bool("EXECUTION_ENABLED", false),
  };
}
