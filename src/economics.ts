import { Decimal } from "decimal.js";
import type { KaminoReserve } from "@kamino-finance/klend-sdk";
import type { BotConfig } from "./config.js";

export type RedemptionEconomics = {
  flashFeeRaw: bigint;
  flashRepaymentRaw: bigint;
  minimumWithdrawRaw: bigint;
  expectedNetBeforeNetworkRaw: bigint;
  expectedNetAfterBudgetRaw: bigint;
};

/** Mirrors Kamino SDK fee math but rounds up so the repayment WSOL ATA is never short by one lamport. */
export function calculateFlashFee(
  reserve: KaminoReserve,
  borrowRaw: bigint,
): bigint {
  const fees = reserve.calculateFlashLoanFees(
    new Decimal(borrowRaw.toString()),
    0,
    false,
  );
  return BigInt(fees.protocolFees.ceil().toFixed(0));
}

/**
 * The only hard economic gate: dynamic stake-pool output must repay the loan,
 * fund the configured worst-case network budget, and retain target profit.
 */
export function calculateRedemptionEconomics(args: {
  reserve: KaminoReserve;
  borrowRaw: bigint;
  expectedWithdrawRaw: bigint;
  config: BotConfig;
}): RedemptionEconomics {
  const { reserve, borrowRaw, expectedWithdrawRaw, config } = args;
  const flashFeeRaw = calculateFlashFee(reserve, borrowRaw);
  const flashRepaymentRaw = borrowRaw + flashFeeRaw;
  const minimumWithdrawRaw =
    flashRepaymentRaw + config.maxTxCostRaw + config.minNetProfitRaw;
  return {
    flashFeeRaw,
    flashRepaymentRaw,
    minimumWithdrawRaw,
    expectedNetBeforeNetworkRaw: expectedWithdrawRaw - flashRepaymentRaw,
    expectedNetAfterBudgetRaw:
      expectedWithdrawRaw - flashRepaymentRaw - config.maxTxCostRaw,
  };
}
