import "dotenv/config";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { formatAtomic, toAtomic, toSafeNumber } from "./amount.js";
import { SOL_DECIMALS } from "./config.js";
import { loadKeypair } from "./wallet.js";

const DEFAULT_KEEP_SOL = "0.02";
const NETWORK_FEE_BUFFER_SOL = "0.0001";

function getFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value after ${name}`);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--yes")) {
    throw new Error(
      "Refusing to transfer. Add --yes after confirming destination and amount.",
    );
  }

  const destinationText = getFlag("--to");
  const amountText = getFlag("--amount");
  if (!destinationText || !amountText) {
    throw new Error(
      "Usage: npm run wallet:send-sol -- --to <recipient-public-key> --amount <SOL> [--keep <SOL>] --yes",
    );
  }

  let destination: PublicKey;
  try {
    destination = new PublicKey(destinationText);
  } catch {
    throw new Error("--to must be a valid Solana public address");
  }

  const amountRaw = toAtomic(amountText, SOL_DECIMALS);
  const keepRaw = toAtomic(
    getFlag("--keep") ?? process.env.PAYOUT_KEEP_SOL ?? DEFAULT_KEEP_SOL,
    SOL_DECIMALS,
  );
  const feeBufferRaw = toAtomic(NETWORK_FEE_BUFFER_SOL, SOL_DECIMALS);
  if (amountRaw === 0n) throw new Error("--amount must be greater than zero");

  const payer = await loadKeypair(requiredEnv("KEYPAIR_PATH"));
  if (destination.equals(payer.publicKey))
    throw new Error("Destination cannot be the bot wallet itself");

  const connection = new Connection(requiredEnv("RPC_URL"), "confirmed");
  const balanceRaw = BigInt(
    await connection.getBalance(payer.publicKey, "confirmed"),
  );
  const requiredRaw = amountRaw + keepRaw + feeBufferRaw;
  if (balanceRaw < requiredRaw) {
    throw new Error(
      `Insufficient SOL. Balance: ${formatAtomic(balanceRaw, SOL_DECIMALS)}; ` +
        `send: ${formatAtomic(amountRaw, SOL_DECIMALS)}; keep: ${formatAtomic(keepRaw, SOL_DECIMALS)}; ` +
        `fee buffer: ${formatAtomic(feeBufferRaw, SOL_DECIMALS)}`,
    );
  }

  console.log("Sending SOL from the local bot keypair:");
  console.log(`  From:   ${payer.publicKey.toBase58()}`);
  console.log(`  To:     ${destination.toBase58()}`);
  console.log(`  Amount: ${formatAtomic(amountRaw, SOL_DECIMALS)} SOL`);
  console.log(
    `  Keep:   ${formatAtomic(keepRaw, SOL_DECIMALS)} SOL (+ ${formatAtomic(feeBufferRaw, SOL_DECIMALS)} fee buffer)`,
  );

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: destination,
      lamports: toSafeNumber(amountRaw, "SOL transfer amount"),
    }),
  );
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [payer],
    {
      commitment: "confirmed",
      maxRetries: 3,
    },
  );
  console.log(`\nConfirmed transfer: https://solscan.io/tx/${signature}`);
}

main().catch((error: unknown) => {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
});
