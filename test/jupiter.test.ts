import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { BotConfig } from "../src/config.js";
import { getJupiterQuote } from "../src/jupiter.js";

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const config = {
  jupiterApiBase: "https://api.example.test/swap/v1",
  slippageBps: 25,
  onlyDirectRoutes: false,
  maxQuoteAccounts: 40,
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
