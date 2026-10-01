import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import type { KaminoReserve } from "@kamino-finance/klend-sdk";
import type { BotConfig } from "../src/config.js";
import {
  calculateFlashArbEconomics,
  calculateRedemptionEconomics,
} from "../src/economics.js";

const config = {
  minNetProfitRaw: 10_000_000n,
  maxTxCostRaw: 5_000_000n,
} as BotConfig;

const reserve = {
  calculateFlashLoanFees: () => ({
    protocolFees: new Decimal("25000"),
    referrerFees: new Decimal(0),
  }),
} as unknown as KaminoReserve;

describe("dynamic redemption gate", () => {
  it("requires principal, current flash fee, cost budget, and profit target", () => {
    const result = calculateRedemptionEconomics({
      reserve,
      borrowRaw: 2_500_000_000n,
      expectedWithdrawRaw: 2_600_000_000n,
      config,
    });

    expect(result.flashFeeRaw).toBe(25_000n);
    expect(result.flashRepaymentRaw).toBe(2_500_025_000n);
    expect(result.minimumWithdrawRaw).toBe(2_515_025_000n);
    expect(result.expectedNetAfterBudgetRaw).toBe(94_975_000n);
  });

  it("uses the same protected-final-output gate for a DEX cycle", () => {
    const result = calculateFlashArbEconomics({
      reserve,
      borrowRaw: 2_500_000_000n,
      expectedFinalOutputRaw: 2_600_000_000n,
      config,
    });

    expect(result.minimumFinalOutputRaw).toBe(2_515_025_000n);
    expect(result.expectedNetAfterBudgetRaw).toBe(94_975_000n);
  });
});
