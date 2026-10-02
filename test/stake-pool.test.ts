import BN from "bn.js";
import { describe, expect, it } from "vitest";
import type { StakePool } from "@solana/spl-stake-pool";
import { estimateWithdrawSolLamports } from "../src/stake-pool.js";

function poolWithFee(numerator: number, denominator: number): StakePool {
  // Only these fields are read by the estimator; use a narrow fixture rather
  // than an RPC fixture so rounding behavior stays unit-testable.
  return {
    totalLamports: new BN("3311900000"),
    poolTokenSupply: new BN("1113300000"),
    solWithdrawalFee: {
      numerator: new BN(numerator),
      denominator: new BN(denominator),
    },
  } as StakePool;
}

describe("stake-pool instant-withdraw preview", () => {
  it("returns the requested 3.3119 SOL before withdrawal fee", () => {
    expect(estimateWithdrawSolLamports(poolWithFee(0, 1), 1_113_300_000n)).toBe(
      3_311_900_000n,
    );
  });

  it("rounds the fee upward, never overstating proceeds", () => {
    expect(
      estimateWithdrawSolLamports(poolWithFee(1, 1_000), 1_113_300_000n),
    ).toBe(3_308_588_100n);
  });
});
