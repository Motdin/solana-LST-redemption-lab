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

  it("parses exact WSOL candidate amounts and deduplicates them", () => {
    const [strategy] = parseStrategies(base);
    expect(strategy?.borrowAmountsRaw).toEqual([500_000_000n, 2_500_000_000n]);
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
});
