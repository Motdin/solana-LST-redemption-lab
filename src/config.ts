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

export type BotConfig = {
  rpcUrl: string;
  keypairPath: string;
  kaminoLendingMarket: PublicKey;
  kaminoWsolReserve?: PublicKey;
  stakePool: PublicKey;
  lstMint: PublicKey;
  jupiterApiBase: string;
  jupiterApiKey?: string;
  slippageBps: number;
  onlyDirectRoutes: boolean;
  maxQuoteAccounts?: number;
  strictJupiterValidation: boolean;
  flashBorrowRaw: bigint;
  minLstOutRaw: bigint;
  lstToBurnRaw: bigint;
  minWithdrawSolRaw: bigint;
  maxFlashFeeRaw: bigint;
  minNetProfitRaw: bigint;
  maxTxCostRaw: bigint;
  minGasBalanceRaw: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  pollMs: number;
  executionEnabled: boolean;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
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

function positiveInteger(name: string, fallback: number, min = 1): number {
  const source = optional(name) ?? String(fallback);
  if (!/^\d+$/.test(source)) throw new Error(`${name} must be an integer`);
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer ≥ ${min}`);
  }
  return value;
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
 * Reads only configuration, never a private key. The keypair file is loaded later,
 * so `plan` fails before any signing if settings are incomplete.
 */
export function loadConfig(): BotConfig {
  const network = optional("SOLANA_CLUSTER") ?? "mainnet-beta";
  if (network !== "mainnet-beta") {
    throw new Error(
      "This strategy is pinned to mainnet-beta because the configured marginfi LST pool is mainnet-only",
    );
  }

  const flashBorrowRaw = amount("FLASH_BORROW_SOL", "2.5");
  const lstToBurnRaw = amount("LST_TO_BURN", "1.1133");
  const minLstOutRaw = amount("MIN_LST_OUT", "1.1133");
  if (
    flashBorrowRaw === 0n ||
    lstToBurnRaw === 0n ||
    minLstOutRaw < lstToBurnRaw
  ) {
    throw new Error(
      "FLASH_BORROW_SOL and LST_TO_BURN must be positive; MIN_LST_OUT must cover LST_TO_BURN",
    );
  }

  return {
    rpcUrl: required("RPC_URL"),
    keypairPath: required("KEYPAIR_PATH"),
    kaminoLendingMarket: asPublicKey("KAMINO_LENDING_MARKET"),
    kaminoWsolReserve: optional("KAMINO_WSOL_RESERVE")
      ? asPublicKey("KAMINO_WSOL_RESERVE")
      : undefined,
    stakePool: asPublicKey("STAKE_POOL_ADDRESS", MARGINFI_STAKE_POOL),
    lstMint: asPublicKey("LST_MINT", MARGINFI_LST_MINT),
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
    flashBorrowRaw,
    minLstOutRaw,
    lstToBurnRaw,
    minWithdrawSolRaw: amount("MIN_WITHDRAW_SOL", "3.3119"),
    maxFlashFeeRaw: amount("MAX_FLASH_FEE_SOL", "0.00003"),
    minNetProfitRaw: amount("MIN_NET_PROFIT_SOL", "0.01"),
    maxTxCostRaw: amount("MAX_TX_COST_SOL", "0.005"),
    minGasBalanceRaw: amount("MIN_GAS_BALANCE_SOL", "0.02"),
    computeUnitLimit: positiveInteger("COMPUTE_UNIT_LIMIT", 1_200_000, 100_000),
    computeUnitPriceMicroLamports: positiveInteger(
      "COMPUTE_UNIT_PRICE_MICROLAMPORTS",
      10_000,
      0,
    ),
    pollMs: positiveInteger("POLL_MS", 5_000, 500),
    executionEnabled: bool("EXECUTION_ENABLED", false),
  };
}
