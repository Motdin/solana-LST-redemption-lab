import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import type { BotConfig } from "../src/config.js";
import {
  getJupiterQuote,
  getJupiterSwapPlan,
  validateJupiterInstructions,
  type JupiterQuote,
} from "../src/jupiter.js";
import { TOKEN_PROGRAM_ID } from "../src/token.js";

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const config = {
  jupiterApiBase: "https://api.example.test/swap/v1",
  slippageBps: 25,
  onlyDirectRoutes: false,
  maxQuoteAccounts: 40,
  jupiterTimeoutMs: 8_000,
  jupiterMaxRetries: 2,
} as BotConfig;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Jupiter quote venue constraints", () => {
  it("serializes an explicit DEX allowlist and direct-route override", async () => {
    let requestedUrl = "";
    const fetchMock = vi.fn(async (input: string | URL) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          inputMint: WSOL.toBase58(),
          outputMint: USDC.toBase58(),
          inAmount: "100",
          outAmount: "99",
          otherAmountThreshold: "98",
          swapMode: "ExactIn",
          slippageBps: 25,
          priceImpactPct: "0",
          routePlan: [],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await getJupiterQuote(config, WSOL, USDC, 100n, {
      dexes: ["Meteora DLMM", "Raydium CLMM"],
      onlyDirectRoutes: true,
    });

    const requested = new URL(requestedUrl);
    expect(requested.searchParams.get("dexes")).toBe(
      "Meteora DLMM,Raydium CLMM",
    );
    expect(requested.searchParams.get("onlyDirectRoutes")).toBe("true");
  });

  it("rejects incompatible DEX include and exclude options before a request", async () => {
    await expect(
      getJupiterQuote(config, WSOL, USDC, 100n, {
        dexes: ["Meteora DLMM"],
        excludeDexes: ["Raydium CLMM"],
      }),
    ).rejects.toThrow("cannot set both dexes and excludeDexes");
  });
});

function swapInstructionsResponse(instructions: unknown[]): Response {
  return new Response(
    JSON.stringify({
      swapInstruction: {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        accounts: [
          { pubkey: WSOL.toBase58(), isSigner: false, isWritable: true },
        ],
        data: Buffer.from([8]).toString("base64"),
      },
      setupInstructions: instructions,
    }),
    { status: 200 },
  );
}

const campaignQuote = {
  inputMint: WSOL.toBase58(),
  outputMint: USDC.toBase58(),
  inAmount: "100",
  outAmount: "99",
  otherAmountThreshold: "98",
  swapMode: "ExactIn",
  slippageBps: 25,
  priceImpactPct: "0",
  routePlan: [],
} as JupiterQuote;

function tokenInstruction(tag: number, source: PublicKey): unknown {
  return {
    programId: TOKEN_PROGRAM_ID.toBase58(),
    accounts: [
      { pubkey: source.toBase58(), isSigner: false, isWritable: true },
      {
        pubkey: Keypair.generate().publicKey.toBase58(),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: Keypair.generate().publicKey.toBase58(),
        isSigner: true,
        isWritable: false,
      },
    ],
    data: Buffer.from([tag, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64"),
  };
}

describe("strict Jupiter instruction validation", () => {
  const wallet = Keypair.generate().publicKey;
  const kaminoProgram = Keypair.generate().publicKey;
  const outputTokenAccount = Keypair.generate().publicKey;
  const context = { wallet, kaminoProgram, outputTokenAccount };

  it("rejects a token instruction shape the swap does not need", () => {
    expect(() =>
      validateJupiterInstructions(
        [
          new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [
              { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
            ],
            data: Buffer.from([4]), // Approve
          }),
        ],
        context,
      ),
    ).toThrow("SPL Token instruction tag 4");
  });

  it("rejects a transfer that debits the declared swap-output account", () => {
    expect(() =>
      validateJupiterInstructions(
        [
          new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [
              { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
              { pubkey: wallet, isSigner: false, isWritable: true },
            ],
            data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]), // Transfer
          }),
        ],
        context,
      ),
    ).toThrow("transfer out of the declared output account");
  });

  it("rejects the system program and any extra signer", () => {
    expect(() =>
      validateJupiterInstructions(
        [
          new TransactionInstruction({
            programId: SystemProgram.programId,
            keys: [],
            data: Buffer.from([]),
          }),
        ],
        context,
      ),
    ).toThrow("unexpected program");

    const otherSigner = Keypair.generate().publicKey;
    expect(() =>
      validateJupiterInstructions(
        [
          new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [{ pubkey: otherSigner, isSigner: true, isWritable: true }],
            data: Buffer.from([17]), // SyncNative
          }),
        ],
        context,
      ),
    ).toThrow("additional signer");
  });

  it("accepts the shapes an exact-in swap into a known ATA needs", async () => {
    const fetchMock = vi.fn(async () =>
      swapInstructionsResponse([
        {
          programId: TOKEN_PROGRAM_ID.toBase58(),
          accounts: [
            {
              pubkey: Keypair.generate().publicKey.toBase58(),
              isSigner: false,
              isWritable: true,
            },
            { pubkey: USDC.toBase58(), isSigner: false, isWritable: false },
            {
              pubkey: Keypair.generate().publicKey.toBase58(),
              isSigner: false,
              isWritable: true,
            },
          ],
          data: Buffer.from([12]).toString("base64"), // TransferChecked
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const plan = await getJupiterSwapPlan({
      config: { ...config, strictJupiterValidation: true } as BotConfig,
      quote: campaignQuote,
      wallet,
      destinationTokenAccount: outputTokenAccount,
      kaminoProgram,
    });

    expect(plan.swapInstructions).toHaveLength(1);
    expect(plan.setupInstructions).toHaveLength(1);
  });

  it("applies the same rules to a live swap-instructions response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        swapInstructionsResponse([tokenInstruction(9, outputTokenAccount)]),
      ),
    );

    await expect(
      getJupiterSwapPlan({
        config: { ...config, strictJupiterValidation: true } as BotConfig,
        quote: campaignQuote,
        wallet,
        destinationTokenAccount: outputTokenAccount,
        kaminoProgram,
      }),
    ).rejects.toThrow("SPL Token instruction tag 9");
  });
});

describe("Jupiter transport budget", () => {
  it("retries a rate-limited quote instead of dropping the candidate", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(
        JSON.stringify({
          inputMint: WSOL.toBase58(),
          outputMint: USDC.toBase58(),
          inAmount: "100",
          outAmount: "99",
          otherAmountThreshold: "98",
          swapMode: "ExactIn",
          slippageBps: 25,
          priceImpactPct: "0",
          routePlan: [],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const quote = await getJupiterQuote(config, WSOL, USDC, 100n);

    expect(quote.outAmount).toBe("99");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung request instead of blocking the scanner forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            );
          }),
      ),
    );

    await expect(
      getJupiterQuote(
        { ...config, jupiterTimeoutMs: 25, jupiterMaxRetries: 0 } as BotConfig,
        WSOL,
        USDC,
        100n,
      ),
    ).rejects.toThrow("timed out after 25ms");
  });
});
