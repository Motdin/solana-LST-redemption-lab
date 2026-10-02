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

describe("configuration hardening", () => {
  const HARDENING_ENV = [
    "RPC_URL",
    "KAMINO_LENDING_MARKET",
    "KEYPAIR_PATH",
    "SLIPPAGE_BPS",
    "COMPUTE_UNIT_PRICE_MICROLAMPORTS",
    "JUPITER_TIMEOUT_MS",
    "JUPITER_MAX_RETRIES",
    "MIN_SEND_INTERVAL_MS",
    "MAX_SENDS_PER_SESSION",
    "STAKE_POOL_WITHDRAW_SLIPPAGE",
  ] as const;

  function withEnv(
    values: Record<string, string | undefined>,
    run: () => void,
  ) {
    const snapshot = Object.fromEntries(
      HARDENING_ENV.map((name) => [name, process.env[name]]),
    ) as Record<string, string | undefined>;
    try {
      for (const name of HARDENING_ENV) delete process.env[name];
      Object.assign(process.env, {
        KAMINO_LENDING_MARKET: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        ...values,
      });
      run();
    } finally {
      for (const name of HARDENING_ENV) {
        const value = snapshot[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it("requires an encrypted RPC endpoint outside a loopback validator", () => {
    withEnv({ RPC_URL: "http://rpc.example.test" }, () => {
      expect(() => loadConfig({ requireKeypair: false })).toThrow(
        "RPC_URL must use https://",
      );
    });
    withEnv({ RPC_URL: "http://localhost:8899" }, () => {
      expect(loadConfig({ requireKeypair: false }).rpcUrl).toBe(
        "http://localhost:8899",
      );
    });
    withEnv({ RPC_URL: "https://rpc.example.test" }, () => {
      expect(loadConfig({ requireKeypair: false }).rpcUrl).toBe(
        "https://rpc.example.test",
      );
    });
  });

  it("caps slippage and refuses a zero priority fee", () => {
    withEnv(
      { RPC_URL: "https://rpc.example.test", SLIPPAGE_BPS: "1000" },
      () => {
        expect(() => loadConfig({ requireKeypair: false })).toThrow(
          "SLIPPAGE_BPS must be an integer between 1 and 500",
        );
      },
    );
    withEnv(
      {
        RPC_URL: "https://rpc.example.test",
        COMPUTE_UNIT_PRICE_MICROLAMPORTS: "0",
      },
      () => {
        expect(() => loadConfig({ requireKeypair: false })).toThrow(
          "COMPUTE_UNIT_PRICE_MICROLAMPORTS must be an integer ≥ 1",
        );
      },
    );
  });

  it("defaults to on-chain withdraw protection and a bounded send budget", () => {
    withEnv({ RPC_URL: "https://rpc.example.test" }, () => {
      const config = loadConfig({ requireKeypair: false });
      expect(config.stakePoolWithdrawSlippage).toBe(true);
      expect(config.minSendIntervalMs).toBe(10_000);
      expect(config.maxSendsPerSession).toBe(5);
      expect(config.jupiterTimeoutMs).toBe(8_000);
      expect(config.jupiterMaxRetries).toBe(2);
    });
    withEnv(
      {
        RPC_URL: "https://rpc.example.test",
        STAKE_POOL_WITHDRAW_SLIPPAGE: "false",
        MIN_SEND_INTERVAL_MS: "60000",
        MAX_SENDS_PER_SESSION: "1",
      },
      () => {
        const config = loadConfig({ requireKeypair: false });
        expect(config.stakePoolWithdrawSlippage).toBe(false);
        expect(config.minSendIntervalMs).toBe(60_000);
        expect(config.maxSendsPerSession).toBe(1);
      },
    );
  });
});
