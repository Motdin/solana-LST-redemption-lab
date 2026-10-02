import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { toAtomic } from "./amount.js";

export const SOL_DECIMALS = 9;
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

/** Hard ceiling for SLIPPAGE_BPS; an accidental order-of-magnitude typo must fail closed. */
export const MAX_SLIPPAGE_BPS = 500;

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
  /** Hard timeout and bounded retry budget for every Jupiter HTTP call. */
  jupiterTimeoutMs: number;
  jupiterMaxRetries: number;
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
  /**
   * When true, `WithdrawSol` carries an on-chain minimum-lamports-out floor, so
   * a redemption shortfall reverts the whole atomic transaction instead of
   * being silently covered from the wallet's own SOL balance.
   */
  stakePoolWithdrawSlippage: boolean;
  pollMs: number;
  /** Slower default for a bounded but multi-quote public-API observer. */
  pairPollMs: number;
  /** Rate limit and hard stop for the armed execution paths. */
  minSendIntervalMs: number;
  maxSendsPerSession: number;
  /** Local-only destination for CSV and JSONL pair-observation records. */
  pairObservationLogDir: string;
  /** Local-only finalized LST execution receipts and balance reconciliations. */
  executionAuditLogDir: string;
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

function boundedInteger(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = nonNegativeInteger(name, fallback, min);
  if (value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Loopback HTTP is tolerated for a local validator, never for a remote RPC. */
function normalizeRpcUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "RPC_URL must be a valid URL, e.g. https://your-rpc.example.com",
    );
  }
  if (parsed.protocol === "https:") return value;
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    parsed.hostname,
  );
  if (parsed.protocol === "http:" && loopback) return value;
  throw new Error(
    "RPC_URL must use https://; plain http is only accepted for a loopback validator",
  );
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
    rpcUrl: normalizeRpcUrl(required("RPC_URL")),
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
    jupiterTimeoutMs: boundedInteger(
      "JUPITER_TIMEOUT_MS",
      8_000,
      1_000,
      60_000,
    ),
    jupiterMaxRetries: boundedInteger("JUPITER_MAX_RETRIES", 2, 0, 5),
    slippageBps: boundedInteger("SLIPPAGE_BPS", 25, 1, MAX_SLIPPAGE_BPS),
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
    // A zero price is almost certainly a misconfiguration for a transaction
    // that must land atomically; require an explicit, non-zero priority fee.
    computeUnitPriceMicroLamports: positiveInteger(
      "COMPUTE_UNIT_PRICE_MICROLAMPORTS",
      10_000,
      1,
    ),
    stakePoolWithdrawSlippage: bool("STAKE_POOL_WITHDRAW_SLIPPAGE", true),
    pollMs: positiveInteger("POLL_MS", 5_000, 500),
    pairPollMs: positiveInteger("PAIR_POLL_MS", 300_000, 30_000),
    minSendIntervalMs: boundedInteger(
      "MIN_SEND_INTERVAL_MS",
      10_000,
      1_000,
      3_600_000,
    ),
    maxSendsPerSession: boundedInteger("MAX_SENDS_PER_SESSION", 5, 1, 1_000),
    pairObservationLogDir:
      optional("PAIR_OBSERVATION_LOG_DIR") ?? "./logs/pair-observations",
    executionAuditLogDir:
      optional("EXECUTION_AUDIT_LOG_DIR") ?? "./logs/execution-audits",
    executionEnabled: bool("EXECUTION_ENABLED", false),
  };
}
