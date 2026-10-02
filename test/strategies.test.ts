import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseStrategies } from "../src/strategies.js";

describe("public strategy whitelist", () => {
  const base = {
    strategies: [
      {
        id: "marginfi-lst-redemption",
        enabled: true,
        lstMint: "LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp",
        stakePool: "DqhH94PjkZsjAqEze2BEkWhFQJ6EyU6MdtMphMgnXqeK",
        borrowAmountsSol: ["2.5", "0.5", "2.5"],
      },
    ],
  };

  it("parses exact WSOL candidate amounts, defaults mode to execution, and deduplicates them", () => {
    const [strategy] = parseStrategies(base);
    expect(strategy?.borrowAmountsRaw).toEqual([500_000_000n, 2_500_000_000n]);
    expect(strategy?.mode).toBe("execution");
  });

  it("accepts an explicit scan-only strategy mode", () => {
    const scanOnly = structuredClone(base) as {
      strategies: Array<Record<string, unknown>>;
    };
    scanOnly.strategies[0] = {
      ...scanOnly.strategies[0],
      mode: "scan-only",
    };
    expect(parseStrategies(scanOnly)[0]?.mode).toBe("scan-only");
  });

  it("rejects an unknown strategy mode", () => {
    const malformed = structuredClone(base) as {
      strategies: Array<Record<string, unknown>>;
    };
    malformed.strategies[0] = {
      ...malformed.strategies[0],
      mode: "observe",
    };
    expect(() => parseStrategies(malformed)).toThrow(
      'mode must be "execution" or "scan-only"',
    );
  });

  it("rejects a strategy file with untrusted numeric amount input", () => {
    const malformed = structuredClone(base) as {
      strategies: Array<Record<string, unknown>>;
    };
    malformed.strategies[0] = {
      ...malformed.strategies[0],
      borrowAmountsSol: [2.5],
    };
    expect(() => parseStrategies(malformed)).toThrow(
      "must be a decimal string",
    );
  });

  it("keeps configured research pools scan-only within the quote budget", async () => {
    const value = JSON.parse(
      await readFile(new URL("../strategies.json", import.meta.url), "utf8"),
    ) as unknown;
    const strategies = parseStrategies(value);
    const scanOnlyIds = strategies
      .filter((strategy) => strategy.mode === "scan-only")
      .map((strategy) => strategy.id);

    expect(scanOnlyIds).toEqual([
      "compasssol-redemption-scan-only",
      "hsol-redemption-scan-only",
      "pwrsol-redemption-scan-only",
      "jsol-redemption-scan-only",
    ]);
    expect(
      strategies
        .filter((strategy) => strategy.enabled)
        .reduce(
          (total, strategy) => total + strategy.borrowAmountsRaw.length,
          0,
        ),
    ).toBe(42);
  });
});
