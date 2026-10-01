import { Connection } from "@solana/web3.js";
import {
  buildFlashRedeemPlan,
  planSummary,
  sendPlan,
  simulatePlan,
} from "./bot.js";
import { formatAtomic } from "./amount.js";
import { loadConfig, SOL_DECIMALS } from "./config.js";
import {
  isPairObservation,
  rankPairObservations,
  scanPairArbOpportunities,
  type PairScanResult,
} from "./pair-scanner.js";
import { loadPairStrategies } from "./pair-strategies.js";
import {
  isEligibleCandidate,
  rankEligibleCandidates,
  requireBestCandidate,
  scanFlashRedeemOpportunities,
  type ScanResult,
} from "./scanner.js";
import { loadStrategies } from "./strategies.js";
import { loadKeypair } from "./wallet.js";

const [command = "help", ...flags] = process.argv.slice(2);
const yes = flags.includes("--yes");
const watchAndExecute = flags.includes("--execute");

type Runtime = Awaited<ReturnType<typeof getRuntime>>;

function usage(): void {
  console.log(`
Kamino flash-arbitrage scanners

Commands:
  npm run scan                    Quote every LST redemption whitelist entry; never builds, signs, or sends
  npm run scan:pairs              Observe DEX-to-DEX WSOL cycles; quotes only, never builds/signs/sends
  npm run watch:pairs             Re-scan pair observations at POLL_MS; quotes only, never builds/signs/sends
  npm run plan                    Build only the highest-ranked dynamic candidate; never sends
  npm run simulate                Build + simulate the highest-ranked dynamic candidate; never sends
  npm run execute -- --yes        Scan, simulate, then send the top candidate (requires EXECUTION_ENABLED=true)
  npm run watch -- [--execute --yes]
                                  Re-scan at POLL_MS. Observe-only by default.

LST redemption strategies are public whitelist entries in STRATEGIES_FILE.
Pair observations are public, read-only entries in PAIR_STRATEGIES_FILE and have no
plan, simulation, or execution path. Every scan uses protected Jupiter minima and
requires repayment + fee budget + MIN_NET_PROFIT_SOL. Keep EXECUTION_ENABLED=false
until LST redemption simulations are understood.
`);
}

function assertExecutionAllowed(executionEnabled: boolean): void {
  if (!yes)
    throw new Error("Refusing to send: add --yes after the npm command");
  if (!executionEnabled) {
    throw new Error(
      "Refusing to send: set EXECUTION_ENABLED=true in .env as a second, explicit gate",
    );
  }
}

async function getRuntime() {
  const config = loadConfig();
  const [wallet, strategies] = await Promise.all([
    loadKeypair(config.keypairPath),
    loadStrategies(config.strategiesFile),
  ]);
  const connection = new Connection(config.rpcUrl, {
    commitment: "processed",
    disableRetryOnRateLimit: false,
  });
  return { config, wallet, strategies, connection };
}

/** Pair observation deliberately does not load the keypair or request instructions. */
async function getPairRuntime() {
  const config = loadConfig({ requireKeypair: false });
  const strategies = await loadPairStrategies(config.pairStrategiesFile);
  const connection = new Connection(config.rpcUrl, {
    commitment: "processed",
    disableRetryOnRateLimit: false,
  });
  return { config, strategies, connection };
}

function printCandidateSummary(scan: ScanResult): void {
  const rows = scan.candidates.map((candidate) => {
    const decimals = isEligibleCandidate(candidate)
      ? candidate.pool.poolTokenDecimals
      : (candidate.poolTokenDecimals ?? SOL_DECIMALS);
    if (isEligibleCandidate(candidate)) {
      return {
        Strategy: candidate.strategy.id,
        Borrow: formatAtomic(candidate.borrowRaw, SOL_DECIMALS),
        Status: "ELIGIBLE",
        "Protected LST": formatAtomic(candidate.quoteMinimumOutRaw, decimals),
        "Expected SOL": formatAtomic(
          candidate.expectedWithdrawRaw,
          SOL_DECIMALS,
        ),
        "Net after budget": formatAtomic(
          candidate.economics.expectedNetAfterBudgetRaw,
          SOL_DECIMALS,
        ),
        Route: candidate.routeLabels.join(" → "),
        Reason: "",
      };
    }
    return {
      Strategy: candidate.strategy.id,
      Borrow: formatAtomic(candidate.borrowRaw, SOL_DECIMALS),
      Status: "rejected",
      "Protected LST": "-",
      "Expected SOL": "-",
      "Net after budget": "-",
      Route: "-",
      Reason: candidate.reason,
    };
  });

  console.log(
    `\nScan ${scan.scannedAt.toISOString()} | Kamino WSOL available: ${formatAtomic(scan.runtime.availableLiquidityRaw, SOL_DECIMALS)} | Wallet: ${formatAtomic(scan.runtime.walletBalanceRaw, SOL_DECIMALS)} SOL`,
  );
  console.table(rows);
  const ranked = rankEligibleCandidates(scan.candidates);
  if (ranked.length > 0) {
    console.log(
      `Top candidate: ${ranked[0]?.strategy.id} / ${formatAtomic(ranked[0]?.borrowRaw ?? 0n, SOL_DECIMALS)} WSOL`,
    );
  } else {
    console.log(
      "No candidate currently covers flash repayment, fee budget, and MIN_NET_PROFIT_SOL.",
    );
  }
}

function printPairObservationSummary(scan: PairScanResult): void {
  const rows = scan.candidates.map((candidate) => {
    if (isPairObservation(candidate)) {
      return {
        Strategy: candidate.strategy.id,
        Borrow: formatAtomic(candidate.borrowRaw, SOL_DECIMALS),
        Status: candidate.passesEconomicGate ? "GATE PASS" : "observed",
        "Protected intermediate": formatAtomic(
          candidate.protectedIntermediateRaw,
          candidate.intermediateDecimals,
        ),
        "Protected final WSOL": formatAtomic(
          candidate.protectedFinalWsolRaw,
          SOL_DECIMALS,
        ),
        "Net after budget": formatAtomic(
          candidate.economics.expectedNetAfterBudgetRaw,
          SOL_DECIMALS,
        ),
        "Leg 1": candidate.legOneRouteLabels.join(" → "),
        "Leg 2": candidate.legTwoRouteLabels.join(" → "),
        Reason: "",
      };
    }
    return {
      Strategy: candidate.strategy.id,
      Borrow: formatAtomic(candidate.borrowRaw, SOL_DECIMALS),
      Status: "rejected",
      "Protected intermediate": "-",
      "Protected final WSOL": "-",
      "Net after budget": "-",
      "Leg 1": "-",
      "Leg 2": "-",
      Reason: candidate.reason,
    };
  });

  console.log(
    `\nPair observation ${scan.scannedAt.toISOString()} | Kamino WSOL available: ${formatAtomic(scan.runtime.availableLiquidityRaw, SOL_DECIMALS)} | no transaction will be built or sent`,
  );
  console.table(rows);
  const ranked = rankPairObservations(scan.candidates);
  const top = ranked[0];
  if (top) {
    console.log(
      `Top observed cycle: ${top.strategy.id} / ${formatAtomic(top.borrowRaw, SOL_DECIMALS)} WSOL (${top.passesEconomicGate ? "clears the economic gate, but has no execution path" : "does not clear the economic gate"}).`,
    );
  } else {
    console.log(
      "No pair cycle produced two valid protected quotes in this scan.",
    );
  }
}

function printPlanSummary(summary: ReturnType<typeof planSummary>): void {
  console.table(summary);
}

async function scan(runtime: Runtime): Promise<ScanResult> {
  const result = await scanFlashRedeemOpportunities({
    connection: runtime.connection,
    wallet: runtime.wallet,
    config: runtime.config,
    strategies: runtime.strategies,
  });
  printCandidateSummary(result);
  return result;
}

async function runPairObservationOnce(): Promise<void> {
  const runtime = await getPairRuntime();
  const result = await scanPairArbOpportunities({
    connection: runtime.connection,
    config: runtime.config,
    strategies: runtime.strategies,
  });
  printPairObservationSummary(result);
}

async function watchPairObservations(): Promise<void> {
  const runtime = await getPairRuntime();
  console.log(
    `Watching ${runtime.strategies.filter((strategy) => strategy.enabled).length} DEX-cycle observation strategies every ${runtime.config.pairPollMs}ms. Quote-only: no keypair is loaded, no transaction is built, signed, simulated, or sent. Ctrl-C to stop.`,
  );
  for (;;) {
    try {
      const result = await scanPairArbOpportunities({
        connection: runtime.connection,
        config: runtime.config,
        strategies: runtime.strategies,
      });
      printPairObservationSummary(result);
    } catch (error) {
      console.log(
        `Pair observation failed: ${(error as Error).message.split("\n")[0]}`,
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, runtime.config.pairPollMs),
    );
  }
}

async function runOnce(
  mode: "scan" | "plan" | "simulate" | "execute",
): Promise<void> {
  const runtime = await getRuntime();
  console.log(`Searcher wallet: ${runtime.wallet.publicKey.toBase58()}`);
  const result = await scan(runtime);
  if (mode === "scan") return;

  const candidate = requireBestCandidate(result, runtime.config);
  const plan = await buildFlashRedeemPlan({
    connection: runtime.connection,
    wallet: runtime.wallet,
    config: runtime.config,
    runtime: result.runtime,
    candidate,
  });
  printPlanSummary(planSummary(plan));
  if (mode === "plan") return;

  const simulation = await simulatePlan(runtime.connection, plan);
  console.log(
    `Simulation succeeded${simulation.unitsConsumed ? `; ${simulation.unitsConsumed} compute units` : ""}.`,
  );
  if (mode === "simulate") return;

  assertExecutionAllowed(runtime.config.executionEnabled);
  const signature = await sendPlan(runtime.connection, plan);
  console.log(`Sent atomic transaction: https://solscan.io/tx/${signature}`);
}

async function watch(): Promise<void> {
  const runtime = await getRuntime();
  if (watchAndExecute) assertExecutionAllowed(runtime.config.executionEnabled);

  console.log(
    `Watching ${runtime.strategies.filter((strategy) => strategy.enabled).length} whitelist strategy entries as ${runtime.wallet.publicKey.toBase58()} every ${runtime.config.pollMs}ms (${watchAndExecute ? "EXECUTION ARMED" : "observe-only"}). Ctrl-C to stop.`,
  );
  for (;;) {
    try {
      const result = await scan(runtime);
      const candidate = requireBestCandidate(result, runtime.config);
      const plan = await buildFlashRedeemPlan({
        connection: runtime.connection,
        wallet: runtime.wallet,
        config: runtime.config,
        runtime: result.runtime,
        candidate,
      });
      const simulation = await simulatePlan(runtime.connection, plan);
      console.log(
        `Top candidate passed simulation${simulation.unitsConsumed ? ` (${simulation.unitsConsumed} CU)` : ""}.`,
      );
      printPlanSummary(planSummary(plan));
      if (watchAndExecute) {
        const signature = await sendPlan(runtime.connection, plan);
        console.log(
          `Sent atomic transaction: https://solscan.io/tx/${signature}`,
        );
      }
    } catch (error) {
      console.log(
        `No executable candidate: ${(error as Error).message.split("\n")[0]}`,
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, runtime.config.pollMs),
    );
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "scan":
      await runOnce("scan");
      return;
    case "scan:pairs":
      await runPairObservationOnce();
      return;
    case "watch:pairs":
      await watchPairObservations();
      return;
    case "plan":
      await runOnce("plan");
      return;
    case "simulate":
      await runOnce("simulate");
      return;
    case "execute":
      await runOnce("execute");
      return;
    case "watch":
      await watch();
      return;
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    default:
      usage();
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\nError: ${(error as Error).message}`);
  process.exitCode = 1;
});
