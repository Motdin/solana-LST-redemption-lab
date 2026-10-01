import { describe, expect, it } from "vitest";
import { parsePairStrategies } from "../src/pair-strategies.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function strategy(overrides: Record<string, unknown> = {}) {
  return {
    id: "wsol-usdc-meteora-to-raydium",
    enabled: true,
    intermediateMint: USDC,
    legOneDexes: ["Meteora DLMM"],
    legTwoDexes: ["Raydium CLMM"],
    borrowAmountsSol: ["2.5", "0.5", "2.500000000"],
    ...overrides,
  };
}

describe("pair strategy whitelist", () => {
  it("normalizes exact WSOL borrow amounts while preserving venue separation", () => {
    const parsed = parsePairStrategies({ strategies: [strategy()] });

    expect(parsed[0]?.borrowAmountsRaw).toEqual([500_000_000n, 2_500_000_000n]);
    expect(parsed[0]?.legOneDexes).toEqual(["Meteora DLMM"]);
    expect(parsed[0]?.legTwoDexes).toEqual(["Raydium CLMM"]);
  });

  it("rejects a same-venue cycle before making any quote request", () => {
    expect(() =>
      parsePairStrategies({
        strategies: [strategy({ legTwoDexes: ["meteora dlmm"] })],
      }),
    ).toThrow("venues must be disjoint");
  });

  it("counts both legs against the bounded quote budget", () => {
    const manyAmounts = Array.from({ length: 12 }, (_, index) =>
      String(index + 1),
    );
    expect(() =>
      parsePairStrategies({
        strategies: Array.from({ length: 3 }, (_, index) =>
          strategy({ id: `route-${index}`, borrowAmountsSol: manyAmounts }),
        ),
      }),
    ).toThrow("exceed 64 Jupiter quotes");
  });
});
