import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import {
  requireBestPairCandidate,
  type PairObservation,
  type PairScanResult,
} from "../src/pair-scanner.js";
import type { PairArbStrategy } from "../src/pair-strategies.js";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const strategy: PairArbStrategy = {
  id: "wsol-usdc-meteora-to-raydium",
  enabled: true,
  intermediateMint: new PublicKey(USDC),
  legOneDexes: ["Meteora DLMM"],
  legTwoDexes: ["Raydium CLMM"],
  borrowAmountsRaw: [500_000_000n],
};

function observation(passesEconomicGate: boolean): PairObservation {
  return {
    status: "observed",
    strategy,
    borrowRaw: 500_000_000n,
    intermediateDecimals: 6,
    firstQuote: {
      inputMint: WSOL,
      outputMint: USDC,
      inAmount: "500000000",
      outAmount: "58300000",
      otherAmountThreshold: "58200000",
      swapMode: "ExactIn",
      slippageBps: 25,
      priceImpactPct: "0",
      routePlan: [],
    },
    secondQuote: {
      inputMint: USDC,
      outputMint: WSOL,
      inAmount: "58200000",
      outAmount: "516000000",
      otherAmountThreshold: "515005000",
      swapMode: "ExactIn",
      slippageBps: 25,
      priceImpactPct: "0",
      routePlan: [],
    },
    protectedIntermediateRaw: 58_200_000n,
    protectedFinalWsolRaw: 515_005_000n,
    economics: {
      flashFeeRaw: 5_000n,
      flashRepaymentRaw: 500_005_000n,
      minimumFinalOutputRaw: 515_005_000n,
      expectedNetBeforeNetworkRaw: 15_000_000n,
      expectedNetAfterBudgetRaw: 10_000_000n,
    },
    passesEconomicGate,
    legOneRouteLabels: ["Meteora DLMM"],
    legTwoRouteLabels: ["Raydium CLMM"],
  };
}

const config = {
  minGasBalanceRaw: 20_000_000n,
} as BotConfig;

function scan(candidate: PairObservation): PairScanResult {
  return {
    scannedAt: new Date(),
    runtime: {
      market: {} as PairScanResult["runtime"]["market"],
      reserve: {} as PairScanResult["runtime"]["reserve"],
      availableLiquidityRaw: 1_000_000_000n,
    },
    candidates: [candidate],
  };
}

describe("pair plan eligibility", () => {
  it("permits only a current protected candidate that clears the economic gate", () => {
    const candidate = observation(true);
    expect(
      requireBestPairCandidate({
        scan: scan(candidate),
        config,
        walletBalanceRaw: 20_000_000n,
      }),
    ).toBe(candidate);
  });

  it("refuses a losing pair observation before any instruction is requested", () => {
    expect(() =>
      requireBestPairCandidate({
        scan: scan(observation(false)),
        config,
        walletBalanceRaw: 20_000_000n,
      }),
    ).toThrow("No economically eligible pair candidate");
  });
});
