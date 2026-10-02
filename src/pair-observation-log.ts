import { appendFile, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { formatAtomic } from "./amount.js";
import { SOL_DECIMALS, type BotConfig } from "./config.js";
import {
  isPairObservation,
  type PairObservation,
  type PairScanCandidate,
  type PairScanResult,
} from "./pair-scanner.js";

const CSV_HEADER = [
  "scanned_at_utc",
  "kamino_available_wsol",
  "slippage_bps",
  "max_tx_cost_sol",
  "min_net_profit_sol",
  "strategy",
  "status",
  "borrow_wsol",
  "intermediate_mint",
  "protected_intermediate",
  "first_quote_out",
  "first_quote_price_impact_pct",
  "leg_one_venues",
  "protected_final_wsol",
  "second_quote_out",
  "second_quote_price_impact_pct",
  "leg_two_venues",
  "gross_round_trip_wsol",
  "flash_fee_wsol",
  "flash_repayment_wsol",
  "minimum_final_wsol",
  "net_before_network_wsol",
  "net_after_budget_wsol",
  "passes_economic_gate",
  "reason",
] as const;

export type PairObservationLogPaths = {
  jsonlPath: string;
  csvPath: string;
};

function dailyFileSuffix(scannedAt: Date): string {
  return scannedAt.toISOString().slice(0, 10);
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function isEmptyOrMissing(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function observationRecord(candidate: PairObservation) {
  const grossRoundTripRaw =
    candidate.protectedFinalWsolRaw - candidate.borrowRaw;
  return {
    status: candidate.status,
    strategy: candidate.strategy.id,
    borrowRaw: candidate.borrowRaw.toString(),
    intermediateMint: candidate.strategy.intermediateMint.toBase58(),
    protectedIntermediateRaw: candidate.protectedIntermediateRaw.toString(),
    protectedFinalWsolRaw: candidate.protectedFinalWsolRaw.toString(),
    grossRoundTripRaw: grossRoundTripRaw.toString(),
    firstQuote: {
      outAmountRaw: candidate.firstQuote.outAmount,
      protectedOutRaw: candidate.firstQuote.otherAmountThreshold,
      priceImpactPct: candidate.firstQuote.priceImpactPct,
      routeLabels: candidate.legOneRouteLabels,
    },
    secondQuote: {
      outAmountRaw: candidate.secondQuote.outAmount,
      protectedOutRaw: candidate.secondQuote.otherAmountThreshold,
      priceImpactPct: candidate.secondQuote.priceImpactPct,
      routeLabels: candidate.legTwoRouteLabels,
    },
    economics: {
      flashFeeRaw: candidate.economics.flashFeeRaw.toString(),
      flashRepaymentRaw: candidate.economics.flashRepaymentRaw.toString(),
      minimumFinalOutputRaw:
        candidate.economics.minimumFinalOutputRaw.toString(),
      expectedNetBeforeNetworkRaw:
        candidate.economics.expectedNetBeforeNetworkRaw.toString(),
      expectedNetAfterBudgetRaw:
        candidate.economics.expectedNetAfterBudgetRaw.toString(),
    },
    passesEconomicGate: candidate.passesEconomicGate,
  };
}

function candidateRecord(candidate: PairScanCandidate) {
  if (isPairObservation(candidate)) return observationRecord(candidate);
  return {
    status: candidate.status,
    strategy: candidate.strategy.id,
    borrowRaw: candidate.borrowRaw.toString(),
    intermediateMint: candidate.strategy.intermediateMint.toBase58(),
    reason: candidate.reason,
  };
}

function observationCsvRow(args: {
  scannedAt: string;
  availableLiquidityRaw: bigint;
  config: BotConfig;
  candidate: PairObservation;
}): string {
  const { scannedAt, availableLiquidityRaw, config, candidate } = args;
  const grossRoundTripRaw =
    candidate.protectedFinalWsolRaw - candidate.borrowRaw;
  return [
    scannedAt,
    formatAtomic(availableLiquidityRaw, SOL_DECIMALS),
    String(config.slippageBps),
    formatAtomic(config.maxTxCostRaw, SOL_DECIMALS),
    formatAtomic(config.minNetProfitRaw, SOL_DECIMALS),
    candidate.strategy.id,
    candidate.passesEconomicGate ? "gate_pass" : "observed",
    formatAtomic(candidate.borrowRaw, SOL_DECIMALS),
    candidate.strategy.intermediateMint.toBase58(),
    formatAtomic(
      candidate.protectedIntermediateRaw,
      candidate.intermediateDecimals,
    ),
    formatAtomic(
      BigInt(candidate.firstQuote.outAmount),
      candidate.intermediateDecimals,
    ),
    candidate.firstQuote.priceImpactPct,
    candidate.legOneRouteLabels.join(" → "),
    formatAtomic(candidate.protectedFinalWsolRaw, SOL_DECIMALS),
    formatAtomic(BigInt(candidate.secondQuote.outAmount), SOL_DECIMALS),
    candidate.secondQuote.priceImpactPct,
    candidate.legTwoRouteLabels.join(" → "),
    formatAtomic(grossRoundTripRaw, SOL_DECIMALS),
    formatAtomic(candidate.economics.flashFeeRaw, SOL_DECIMALS),
    formatAtomic(candidate.economics.flashRepaymentRaw, SOL_DECIMALS),
    formatAtomic(candidate.economics.minimumFinalOutputRaw, SOL_DECIMALS),
    formatAtomic(candidate.economics.expectedNetBeforeNetworkRaw, SOL_DECIMALS),
    formatAtomic(candidate.economics.expectedNetAfterBudgetRaw, SOL_DECIMALS),
    String(candidate.passesEconomicGate),
    "",
  ]
    .map(csvCell)
    .join(",");
}

function rejectedCsvRow(args: {
  scannedAt: string;
  availableLiquidityRaw: bigint;
  config: BotConfig;
  candidate: Exclude<PairScanCandidate, PairObservation>;
}): string {
  const { scannedAt, availableLiquidityRaw, config, candidate } = args;
  return [
    scannedAt,
    formatAtomic(availableLiquidityRaw, SOL_DECIMALS),
    String(config.slippageBps),
    formatAtomic(config.maxTxCostRaw, SOL_DECIMALS),
    formatAtomic(config.minNetProfitRaw, SOL_DECIMALS),
    candidate.strategy.id,
    candidate.status,
    formatAtomic(candidate.borrowRaw, SOL_DECIMALS),
    candidate.strategy.intermediateMint.toBase58(),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "false",
    candidate.reason,
  ]
    .map(csvCell)
    .join(",");
}

function candidateCsvRow(args: {
  scannedAt: string;
  availableLiquidityRaw: bigint;
  config: BotConfig;
  candidate: PairScanCandidate;
}): string {
  return isPairObservation(args.candidate)
    ? observationCsvRow({
        ...args,
        candidate: args.candidate,
      })
    : rejectedCsvRow({
        ...args,
        candidate: args.candidate,
      });
}

/**
 * Append one whole scan as JSONL and one candidate per CSV row. Both files are
 * local analytics artifacts only and contain quote/public market data—never a
 * keypair, signature, instruction, or transaction payload.
 */
export async function appendPairObservationLogs(args: {
  directory: string;
  scan: PairScanResult;
  config: BotConfig;
}): Promise<PairObservationLogPaths> {
  const { directory, scan, config } = args;
  const resolvedDirectory = resolve(directory);
  const suffix = dailyFileSuffix(scan.scannedAt);
  const jsonlPath = `${resolvedDirectory}/pair-observations-${suffix}.jsonl`;
  const csvPath = `${resolvedDirectory}/pair-candidates-${suffix}.csv`;
  const scannedAt = scan.scannedAt.toISOString();

  const record = {
    schemaVersion: 1,
    scannedAt,
    observer: {
      kaminoAvailableLiquidityRaw:
        scan.runtime.availableLiquidityRaw.toString(),
      slippageBps: config.slippageBps,
      maxTxCostRaw: config.maxTxCostRaw.toString(),
      minNetProfitRaw: config.minNetProfitRaw.toString(),
    },
    candidates: scan.candidates.map(candidateRecord),
  };
  const csvRows = scan.candidates.map((candidate) =>
    candidateCsvRow({
      scannedAt,
      availableLiquidityRaw: scan.runtime.availableLiquidityRaw,
      config,
      candidate,
    }),
  );

  await mkdir(resolvedDirectory, { recursive: true });
  const needsHeader = await isEmptyOrMissing(csvPath);
  await Promise.all([
    appendFile(jsonlPath, `${JSON.stringify(record)}\n`, "utf8"),
    appendFile(
      csvPath,
      `${needsHeader ? `${CSV_HEADER.join(",")}\n` : ""}${csvRows.join("\n")}\n`,
      "utf8",
    ),
  ]);
  return { jsonlPath, csvPath };
}
