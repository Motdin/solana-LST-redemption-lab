import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import { appendPairObservationLogs } from "../src/pair-observation-log.js";
import type { PairObservation, PairScanResult } from "../src/pair-scanner.js";
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
const firstQuote = {
  inputMint: WSOL,
  outputMint: USDC,
  inAmount: "500000000",
  outAmount: "58300000",
  otherAmountThreshold: "58200000",
  swapMode: "ExactIn" as const,
  slippageBps: 25,
  priceImpactPct: "0.0001",
  routePlan: [],
};
const secondQuote = {
  inputMint: USDC,
  outputMint: WSOL,
  inAmount: "58200000",
  outAmount: "498000000",
  otherAmountThreshold: "497000000",
  swapMode: "ExactIn" as const,
  slippageBps: 25,
  priceImpactPct: "0.0002",
  routePlan: [],
};
const observation: PairObservation = {
  status: "observed",
  strategy,
  borrowRaw: 500_000_000n,
  intermediateDecimals: 6,
  firstQuote,
  secondQuote,
  protectedIntermediateRaw: 58_200_000n,
  protectedFinalWsolRaw: 497_000_000n,
  economics: {
    flashFeeRaw: 5_000n,
    flashRepaymentRaw: 500_005_000n,
    minimumFinalOutputRaw: 515_005_000n,
    expectedNetBeforeNetworkRaw: -3_005_000n,
    expectedNetAfterBudgetRaw: -8_005_000n,
  },
  passesEconomicGate: false,
  legOneRouteLabels: ["Meteora DLMM"],
  legTwoRouteLabels: ["Raydium CLMM"],
};
const scan: PairScanResult = {
  scannedAt: new Date("2026-10-01T15:10:08.875Z"),
  runtime: {
    reserve: {} as PairScanResult["runtime"]["reserve"],
    availableLiquidityRaw: 221_488_398_311_788n,
  },
  candidates: [
    observation,
    {
      status: "rejected",
      strategy,
      borrowRaw: 2_500_000_000n,
      reason: "Jupiter leg one quote has no route plan",
    },
  ],
};
const config = {
  slippageBps: 25,
  maxTxCostRaw: 5_000_000n,
  minNetProfitRaw: 10_000_000n,
} as BotConfig;

const logDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    logDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("pair-observation log", () => {
  it("appends complete JSONL records and a single-header CSV candidate table", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pair-observation-"));
    logDirectories.push(directory);
    const first = await appendPairObservationLogs({ directory, scan, config });
    const second = await appendPairObservationLogs({ directory, scan, config });

    expect(first).toEqual(second);
    const jsonl = await readFile(first.jsonlPath, "utf8");
    const jsonRecords: Array<{
      candidates: Array<{ economics?: { flashFeeRaw?: string } }>;
    }> = jsonl
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            candidates: Array<{ economics?: { flashFeeRaw?: string } }>;
          },
      );
    expect(jsonRecords).toHaveLength(2);
    expect(jsonRecords[0]?.candidates).toHaveLength(2);
    expect(jsonRecords[0]?.candidates[0]?.economics?.flashFeeRaw).toBe("5000");

    const csv = await readFile(first.csvPath, "utf8");
    const csvLines = csv.trim().split("\n");
    expect(csvLines).toHaveLength(5);
    expect(csvLines[0]).toContain("gross_round_trip_wsol");
    expect(
      csvLines.filter((line) => line.includes("scanned_at_utc")),
    ).toHaveLength(1);
    expect(csv).toContain("Jupiter leg one quote has no route plan");
  });
});
