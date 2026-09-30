import { Connection } from "@solana/web3.js";
import {
  buildFlashRedeemPlan,
  planSummary,
  sendPlan,
  simulatePlan,
} from "./bot.js";
import { loadConfig } from "./config.js";
import { loadKeypair } from "./wallet.js";

const [command = "help", ...flags] = process.argv.slice(2);
const yes = flags.includes("--yes");
const watchAndExecute = flags.includes("--execute");

function usage(): void {
  console.log(`
marginfi LST / Kamino atomic flash bot

Commands:
  npm run plan                    Quote and build the transaction; never simulates or sends
  npm run simulate                Quote, build, and simulate; never sends
  npm run execute -- --yes        Simulate then send once (also requires EXECUTION_ENABLED=true)
  npm run watch -- [--execute --yes]
                                  Re-quote every POLL_MS; observe by default. Sending needs both flags

The bot reads .env. Copy .env.example, use a dedicated hot-wallet keypair, and
keep EXECUTION_ENABLED=false until a simulation is understood.
`);
}

function assertExecutionAllowed(executionEnabled: boolean): void {
  if (!yes)
    throw new Error("Refusing to send: add --yes after the npm command");
  if (!executionEnabled)
    throw new Error(
      "Refusing to send: set EXECUTION_ENABLED=true in .env as a second, explicit gate",
    );
}

async function getRuntime() {
  const config = loadConfig();
  const [wallet] = await Promise.all([loadKeypair(config.keypairPath)]);
  const connection = new Connection(config.rpcUrl, {
    commitment: "processed",
    disableRetryOnRateLimit: false,
  });
  return { config, wallet, connection };
}

function printSummary(summary: ReturnType<typeof planSummary>): void {
  console.table(summary);
}

async function runOnce(mode: "plan" | "simulate" | "execute"): Promise<void> {
  const { config, wallet, connection } = await getRuntime();
  console.log(`Searcher wallet: ${wallet.publicKey.toBase58()}`);
  const plan = await buildFlashRedeemPlan({ connection, wallet, config });
  printSummary(planSummary(plan));

  if (mode === "plan") return;
  const simulation = await simulatePlan(connection, plan);
  console.log(
    `Simulation succeeded${simulation.unitsConsumed ? `; ${simulation.unitsConsumed} compute units` : ""}.`,
  );
  if (mode === "simulate") return;

  assertExecutionAllowed(config.executionEnabled);
  const signature = await sendPlan(connection, plan);
  console.log(`Sent atomic transaction: https://solscan.io/tx/${signature}`);
}

async function watch(): Promise<void> {
  const { config, wallet, connection } = await getRuntime();
  const shouldExecute = watchAndExecute;
  if (shouldExecute) assertExecutionAllowed(config.executionEnabled);

  console.log(
    `Watching as ${wallet.publicKey.toBase58()} every ${config.pollMs}ms (${shouldExecute ? "EXECUTION ARMED" : "observe-only"}). Ctrl-C to stop.`,
  );
  for (;;) {
    const started = new Date().toISOString();
    try {
      const plan = await buildFlashRedeemPlan({ connection, wallet, config });
      const simulation = await simulatePlan(connection, plan);
      console.log(
        `${started} candidate passed simulation${simulation.unitsConsumed ? ` (${simulation.unitsConsumed} CU)` : ""}`,
      );
      printSummary(planSummary(plan));
      if (shouldExecute) {
        const signature = await sendPlan(connection, plan);
        console.log(
          `Sent atomic transaction: https://solscan.io/tx/${signature}`,
        );
      }
    } catch (error) {
      // A rejected candidate is expected while the spread is absent; the watch
      // loop does not weaken any check just because the previous one failed.
      console.log(
        `${started} no executable candidate: ${(error as Error).message.split("\n")[0]}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, config.pollMs));
  }
}

async function main(): Promise<void> {
  switch (command) {
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
