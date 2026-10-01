import { Decimal } from "decimal.js";
import type { KaminoReserve } from "@kamino-finance/klend-sdk";
import type { BotConfig } from "./config.js";

/** Shared economics for a flash-funded route that ends in WSOL. */
export type FlashArbEconomics = {
  flashFeeRaw: bigint;
  flashRepaymentRaw: bigint;
  minimumFinalOutputRaw: bigint;
  expectedNetBeforeNetworkRaw: bigint;
  expectedNetAfterBudgetRaw: bigint;
};

/** Same economics, with a stake-pool-specific name retained for the LST scanner. */
export type RedemptionEconomics = FlashArbEconomics & {
  minimumWithdrawRaw: bigint;
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
 * Conservative economics for any route that flash-borrows and finishes in the
 * borrowed mint. `expectedFinalOutputRaw` must be a protected on-chain minimum,
 * never an optimistic quote amount.
 */
export function calculateFlashArbEconomics(args: {
  reserve: KaminoReserve;
  borrowRaw: bigint;
  expectedFinalOutputRaw: bigint;
  config: BotConfig;
}): FlashArbEconomics {
  const { reserve, borrowRaw, expectedFinalOutputRaw, config } = args;
  const flashFeeRaw = calculateFlashFee(reserve, borrowRaw);
  const flashRepaymentRaw = borrowRaw + flashFeeRaw;
  const minimumFinalOutputRaw =
    flashRepaymentRaw + config.maxTxCostRaw + config.minNetProfitRaw;
  return {
    flashFeeRaw,
    flashRepaymentRaw,
    minimumFinalOutputRaw,
    expectedNetBeforeNetworkRaw: expectedFinalOutputRaw - flashRepaymentRaw,
    expectedNetAfterBudgetRaw:
      expectedFinalOutputRaw - flashRepaymentRaw - config.maxTxCostRaw,
  };
}

/**
 * Stake-pool-specific wrapper. The LST scanner retains `minimumWithdrawRaw` in
 * its output so its diagnostics remain explicit about the redemption step.
 */
export function calculateRedemptionEconomics(args: {
  reserve: KaminoReserve;
  borrowRaw: bigint;
  expectedWithdrawRaw: bigint;
  config: BotConfig;
}): RedemptionEconomics {
  const economics = calculateFlashArbEconomics({
    reserve: args.reserve,
    borrowRaw: args.borrowRaw,
    expectedFinalOutputRaw: args.expectedWithdrawRaw,
    config: args.config,
  });
  return {
    ...economics,
    minimumWithdrawRaw: economics.minimumFinalOutputRaw,
  };
}
