import {
  ComputeBudgetProgram,
  PublicKey,
  StakeProgram,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { STAKE_POOL_PROGRAM_ID } from "@solana/spl-stake-pool";
import { type BotConfig } from "./config.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./token.js";

export type JupiterQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label?: string;
      inputMint: string;
      outputMint: string;
    };
    percent: number;
  }>;
};

type JupiterInstructionPayload = {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
};

type JupiterSwapInstructionsResponse = {
  error?: string;
  setupInstructions?: JupiterInstructionPayload[];
  otherInstructions?: JupiterInstructionPayload[];
  tokenLedgerInstruction?: JupiterInstructionPayload | null;
  swapInstruction?: JupiterInstructionPayload | null;
  cleanupInstruction?: JupiterInstructionPayload | null;
  computeBudgetInstructions?: JupiterInstructionPayload[];
  addressLookupTableAddresses?: string[];
};

export type JupiterSwapPlan = {
  quote: JupiterQuote;
  setupInstructions: TransactionInstruction[];
  swapInstructions: TransactionInstruction[];
  lookupTableAddresses: PublicKey[];
  routeLabels: string[];
};

function apiHeaders(config: BotConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The aggregator is an external HTTP dependency on the critical path of an
 * atomic transaction, so every call is bounded by a timeout and a small,
 * jittered retry budget for transport failures and rate limiting.
 */
async function fetchWithBudget(
  config: BotConfig,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const attempts = config.jupiterMaxRetries + 1;
  let lastError = "unknown error";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.jupiterTimeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status !== 429 && response.status < 500) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError =
        (error as Error).name === "AbortError"
          ? `request timed out after ${config.jupiterTimeoutMs}ms`
          : (error as Error).message;
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < attempts) {
      const backoff = Math.min(250 * 2 ** attempt, 2_000);
      await sleep(backoff + Math.floor(Math.random() * 100));
    }
  }

  throw new Error(
    `Jupiter request to ${url} failed after ${attempts} attempt(s): ${lastError}`,
  );
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Jupiter returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
  }
}

function asQuote(value: unknown): JupiterQuote {
  if (!value || typeof value !== "object")
    throw new Error("Jupiter quote response is malformed");
  const quote = value as Partial<JupiterQuote>;
  if (
    typeof quote.inputMint !== "string" ||
    typeof quote.outputMint !== "string" ||
    typeof quote.inAmount !== "string" ||
    typeof quote.outAmount !== "string" ||
    typeof quote.otherAmountThreshold !== "string" ||
    quote.swapMode !== "ExactIn" ||
    !Array.isArray(quote.routePlan)
  ) {
    throw new Error("Jupiter did not return a usable ExactIn quote");
  }
  return quote as JupiterQuote;
}

export type JupiterQuoteOptions = {
  /** Restrict a route to these exact Jupiter DEX labels. */
  dexes?: readonly string[];
  /** Exclude these exact Jupiter DEX labels. Mutually exclusive with dexes. */
  excludeDexes?: readonly string[];
  /** Override the global direct-route setting for this quote. */
  onlyDirectRoutes?: boolean;
};

export async function getJupiterQuote(
  config: BotConfig,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountRaw: bigint,
  options: JupiterQuoteOptions = {},
): Promise<JupiterQuote> {
  if (options.dexes?.length && options.excludeDexes?.length) {
    throw new Error("Jupiter quote cannot set both dexes and excludeDexes");
  }
  const params = new URLSearchParams({
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: amountRaw.toString(),
    slippageBps: String(config.slippageBps),
    onlyDirectRoutes: String(
      options.onlyDirectRoutes ?? config.onlyDirectRoutes,
    ),
    restrictIntermediateTokens: "true",
  });
  if (options.dexes?.length) params.set("dexes", options.dexes.join(","));
  if (options.excludeDexes?.length) {
    params.set("excludeDexes", options.excludeDexes.join(","));
  }
  if (config.maxQuoteAccounts)
    params.set("maxAccounts", String(config.maxQuoteAccounts));

  const url = `${config.jupiterApiBase}/quote?${params.toString()}`;
  const response = await fetchWithBudget(config, url, {
    headers: config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {},
  });
  const json = await parseJson(response);
  if (!response.ok) {
    throw new Error(
      `Jupiter quote failed (HTTP ${response.status}): ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  return asQuote(json);
}

function deserializeInstruction(
  payload: JupiterInstructionPayload,
): TransactionInstruction {
  try {
    return new TransactionInstruction({
      programId: new PublicKey(payload.programId),
      keys: payload.accounts.map((account) => ({
        pubkey: new PublicKey(account.pubkey),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      })),
      data: Buffer.from(payload.data, "base64"),
    });
  } catch (error) {
    throw new Error(
      `Malformed Jupiter instruction: ${(error as Error).message}`,
    );
  }
}

const TOKEN_PROGRAM_IDS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);
const ASSOCIATED_TOKEN_PROGRAM_ID_STRING =
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();

/**
 * SPL Token instruction tags this bot expects to see from an aggregator. The
 * design assumes an exact-input swap into an ATA this bot created itself, so
 * account plumbing is limited to idempotent ATA creation plus the swap and its
 * wrapped-SOL sync. Anything else (`Approve`, `CloseAccount`, `SetAuthority`,
 * `Burn`, transfer-fee instructions, ...) is refused.
 */
const ALLOWED_TOKEN_TAGS = new Map<number, string>([
  [3, "Transfer"],
  [12, "TransferChecked"],
  [17, "SyncNative"],
]);
/** Associated Token Program: 0 = Create, 1 = CreateIdempotent. */
const ALLOWED_ASSOCIATED_TOKEN_TAGS = new Map<number, string>([
  [0, "Create"],
  [1, "CreateIdempotent"],
]);
/** `Transfer` (tag 3) and `TransferChecked` (tag 12) always debit accounts[0]. */
const TOKEN_TRANSFER_TAGS = new Set([3, 12]);

export type JupiterValidationContext = {
  wallet: PublicKey;
  kaminoProgram: PublicKey;
  /**
   * The token account this bot declared as the swap output. A well-formed plan
   * never spends it, so any transfer that debits it is a red flag.
   */
  outputTokenAccount: PublicKey;
};

/**
 * The aggregator is an external instruction source. Program-level rules:
 *
 * - this bot's own flow programs (System, ComputeBudget, Stake, SPL Stake Pool,
 *   Kamino) must never appear in an aggregator response, because a swapped-in
 *   instruction could rebuild or replace the flash-loan flow;
 * - anything calling the SPL Token / Token-2022 / ATA programs must be one of
 *   the small, expected instruction shapes;
 * - no instruction may require a second signer;
 * - the declared swap-output account must never be a transfer source.
 *
 * The DEX programs themselves stay un-restricted because Jupiter adds venues
 * over time; this is a guardrail, not a proof of safety.
 */
export function validateJupiterInstructions(
  instructions: TransactionInstruction[],
  context: JupiterValidationContext,
): void {
  const { wallet, kaminoProgram, outputTokenAccount } = context;
  const forbiddenPrograms = new Set([
    SystemProgram.programId.toBase58(),
    StakeProgram.programId.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
    STAKE_POOL_PROGRAM_ID.toBase58(),
    kaminoProgram.toBase58(),
  ]);

  for (const instruction of instructions) {
    const programId = instruction.programId.toBase58();
    if (forbiddenPrograms.has(programId)) {
      throw new Error(
        `Strict Jupiter validation rejected unexpected program ${programId}`,
      );
    }

    if (TOKEN_PROGRAM_IDS.has(programId)) {
      const tag = instruction.data[0];
      const allowed =
        tag === undefined ? undefined : ALLOWED_TOKEN_TAGS.get(tag);
      if (!allowed) {
        throw new Error(
          `Strict Jupiter validation rejected SPL Token instruction tag ${tag ?? "(empty)"} on ${programId}; only Transfer, TransferChecked, and SyncNative are accepted`,
        );
      }
      if (
        tag !== undefined &&
        TOKEN_TRANSFER_TAGS.has(tag) &&
        instruction.keys[0]?.pubkey.equals(outputTokenAccount)
      ) {
        throw new Error(
          `Strict Jupiter validation rejected a Jupiter transfer out of the declared output account ${outputTokenAccount.toBase58()}`,
        );
      }
    }

    if (programId === ASSOCIATED_TOKEN_PROGRAM_ID_STRING) {
      const tag = instruction.data[0];
      const allowed =
        tag === undefined ? undefined : ALLOWED_ASSOCIATED_TOKEN_TAGS.get(tag);
      if (!allowed) {
        throw new Error(
          `Strict Jupiter validation rejected Associated Token Program instruction tag ${tag ?? "(empty)"}; only Create and CreateIdempotent are accepted`,
        );
      }
    }

    for (const account of instruction.keys) {
      if (account.isSigner && !account.pubkey.equals(wallet)) {
        throw new Error(
          `Strict Jupiter validation rejected additional signer ${account.pubkey.toBase58()}`,
        );
      }
    }
  }
}

export async function getJupiterSwapPlan(args: {
  config: BotConfig;
  quote: JupiterQuote;
  wallet: PublicKey;
  /** Explicit ATA receiving the quote output; Jupiter never chooses it. */
  destinationTokenAccount: PublicKey;
  kaminoProgram: PublicKey;
}): Promise<JupiterSwapPlan> {
  const { config, quote, wallet, destinationTokenAccount, kaminoProgram } =
    args;
  const response = await fetchWithBudget(
    config,
    `${config.jupiterApiBase}/swap-instructions`,
    {
      method: "POST",
      headers: apiHeaders(config),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.toBase58(),
        destinationTokenAccount: destinationTokenAccount.toBase58(),
        wrapAndUnwrapSol: false,
        useSharedAccounts: false,
        dynamicComputeUnitLimit: false,
        // Compute-unit settings are deliberately supplied by this bot, not an API response.
      }),
    },
  );
  const json = (await parseJson(response)) as JupiterSwapInstructionsResponse;
  if (!response.ok || json.error) {
    throw new Error(
      `Jupiter swap-instructions failed (HTTP ${response.status}): ${json.error ?? JSON.stringify(json).slice(0, 500)}`,
    );
  }
  if (!json.swapInstruction)
    throw new Error("Jupiter did not return a swap instruction");
  if (json.cleanupInstruction) {
    throw new Error(
      "Unexpected Jupiter cleanup instruction; WSOL must remain wrapped until Kamino repayment",
    );
  }

  const setupInstructions = (json.setupInstructions ?? []).map(
    deserializeInstruction,
  );
  const swapInstructions = [
    ...(json.tokenLedgerInstruction
      ? [deserializeInstruction(json.tokenLedgerInstruction)]
      : []),
    ...(json.otherInstructions ?? []).map(deserializeInstruction),
    deserializeInstruction(json.swapInstruction),
  ];
  const allInstructions = [...setupInstructions, ...swapInstructions];
  if (config.strictJupiterValidation) {
    validateJupiterInstructions(allInstructions, {
      wallet,
      kaminoProgram,
      outputTokenAccount: destinationTokenAccount,
    });
  }

  const lookupTableAddresses = (json.addressLookupTableAddresses ?? []).map(
    (address) => new PublicKey(address),
  );
  const routeLabels = quote.routePlan
    .map((route) => route.swapInfo.label ?? route.swapInfo.ammKey)
    .filter((label, index, labels) => labels.indexOf(label) === index);

  return {
    quote,
    setupInstructions,
    swapInstructions,
    lookupTableAddresses,
    routeLabels,
  };
}
