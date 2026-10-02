import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const ENV_NAMES = [
  "RPC_URL",
  "KAMINO_LENDING_MARKET",
  "KAMINO_WSOL_RESERVE",
  "KEYPAIR_PATH",
] as const;

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const name of ENV_NAMES) {
    const value = snapshot[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe("configuration signing boundary", () => {
  it("does not require a keypair path for quote-only pair observation", () => {
    const snapshot = Object.fromEntries(
      ENV_NAMES.map((name) => [name, process.env[name]]),
    ) as Record<string, string | undefined>;
    try {
      process.env.RPC_URL = "https://rpc.example.test";
      process.env.KAMINO_LENDING_MARKET =
        "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
      process.env.KAMINO_WSOL_RESERVE =
        "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q";
      delete process.env.KEYPAIR_PATH;

      const config = loadConfig({ requireKeypair: false });
      expect(config.keypairPath).toBe("");
      expect(config.executionAuditLogDir).toBe("./logs/execution-audits");
      expect(() => loadConfig()).toThrow(
        "Missing required environment variable KEYPAIR_PATH",
      );
    } finally {
      restoreEnv(snapshot);
    }
  });
});
