import {
  ComputeBudgetProgram,
  PublicKey,
  StakeProgram,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { STAKE_POOL_PROGRAM_ID } from "@solana/spl-stake-pool";
import type { BotConfig } from "./config.js";

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

  const response = await fetch(
    `${config.jupiterApiBase}/quote?${params.toString()}`,
    {
      headers: config.jupiterApiKey
        ? { "x-api-key": config.jupiterApiKey }
        : {},
    },
  );
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

/**
 * The aggregator is an external instruction source. At a minimum it must not be
 * able to ask a second signer, overwrite this transaction's compute budget, or
 * embed Kamino / stake-pool calls that change the declared flow.
 */
function validateJupiterInstructions(
  instructions: TransactionInstruction[],
  wallet: PublicKey,
  kaminoProgram: PublicKey,
): void {
  const forbiddenPrograms = new Set([
    SystemProgram.programId.toBase58(),
    StakeProgram.programId.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
    STAKE_POOL_PROGRAM_ID.toBase58(),
    kaminoProgram.toBase58(),
  ]);

  for (const instruction of instructions) {
    if (forbiddenPrograms.has(instruction.programId.toBase58())) {
      throw new Error(
        `Strict Jupiter validation rejected unexpected program ${instruction.programId.toBase58()}`,
      );
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
  const response = await fetch(`${config.jupiterApiBase}/swap-instructions`, {
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
  });
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
    validateJupiterInstructions(allInstructions, wallet, kaminoProgram);
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
