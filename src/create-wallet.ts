import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return resolve(homedir(), filePath.slice(2));
  }
  return resolve(filePath);
}

function outputPathFromArgs(): string {
  const outputFlagIndex = process.argv.indexOf("--output");
  if (outputFlagIndex >= 0) {
    const value = process.argv[outputFlagIndex + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("Usage: npm run wallet:create -- --output <path>");
    }
    return expandHome(value);
  }

  const configured = process.env.KEYPAIR_PATH?.trim();
  if (configured) return expandHome(configured);
  return resolve(homedir(), ".config", "solana", "flash-bot.json");
}

async function main(): Promise<void> {
  const outputPath = outputPathFromArgs();
  await mkdir(dirname(outputPath), { recursive: true });

  const keypair = Keypair.generate();
  try {
    // `wx` deliberately prevents an existing wallet from being overwritten.
    // The JSON is the standard 64-byte Solana CLI keypair format accepted by
    // this bot's KEYPAIR_PATH loader.
    await writeFile(outputPath, JSON.stringify([...keypair.secretKey]), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause.code === "EEXIST") {
      throw new Error(
        `Refusing to overwrite an existing keypair: ${outputPath}`,
      );
    }
    throw error;
  }

  const envPath = outputPath.replaceAll("\\", "/");
  console.log("Created a new dedicated bot keypair.");
  console.log(`Public address: ${keypair.publicKey.toBase58()}`);
  console.log(`Keypair file: ${outputPath}`);
  console.log(`\nAdd this local path to .env:\nKEYPAIR_PATH=${envPath}`);
  console.log(
    "\nDo not share, commit, or upload the keypair file or its JSON contents.",
  );
}

main().catch((error: unknown) => {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
});
