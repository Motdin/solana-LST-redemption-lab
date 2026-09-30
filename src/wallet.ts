import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  return resolve(filePath);
}

/** Reads a standard Solana CLI JSON keypair. Secrets are never accepted from env vars. */
export async function loadKeypair(keypairPath: string): Promise<Keypair> {
  const path = expandHome(keypairPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read KEYPAIR_PATH (${path}): ${(error as Error).message}`,
    );
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    )
  ) {
    throw new Error(
      "KEYPAIR_PATH must point to a standard 64-byte Solana CLI JSON keypair array",
    );
  }

  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch (error) {
    throw new Error(`Invalid keypair in ${path}: ${(error as Error).message}`);
  }
}
