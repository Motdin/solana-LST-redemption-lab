import {
  KaminoMarket,
  PROGRAM_ID,
  type KaminoReserve,
} from "@kamino-finance/klend-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { formatAtomic } from "./amount.js";
import { type BotConfig, SOL_DECIMALS, WSOL_MINT } from "./config.js";
import {
  calculateRedemptionEconomics,
  type RedemptionEconomics,
} from "./economics.js";
import { getJupiterQuote, type JupiterQuote } from "./jupiter.js";
import {
  assertSolWithdrawPermission,
  assertStakePoolEpochFresh,
  estimateWithdrawSolLamports,
  loadStakePool,
  type LoadedStakePool,
} from "./stake-pool.js";
import type { FlashRedeemStrategy } from "./strategies.js";

export type ScannerRuntime = {
  market: KaminoMarket;
  reserve: KaminoReserve;
  availableLiquidityRaw: bigint;
  walletBalanceRaw: bigint;
};

export type RejectedCandidate = {
  status: "rejected";
  strategy: FlashRedeemStrategy;
  borrowRaw: bigint;
  reason: string;
  poolTokenDecimals?: number;
};

type QuotedCandidate = {
  strategy: FlashRedeemStrategy;
  borrowRaw: bigint;
  pool: LoadedStakePool;
  quote: JupiterQuote;
  quoteOutRaw: bigint;
  quoteMinimumOutRaw: bigint;
  lstToBurnRaw: bigint;
  expectedWithdrawRaw: bigint;
  economics: RedemptionEconomics;
  routeLabels: string[];
};

/** A candidate that passes every safety and economic gate. */
export type EligibleCandidate = QuotedCandidate & {
  status: "eligible";
};

/**
 * A candidate safe to build and simulate but below the configured profitability
 * threshold. It can never be selected by plan, normal simulate, or execution.
 */
export type TechnicalCandidate = QuotedCandidate & {
  status: "technical";
  economicGateReason: string;
};

export type BuildableCandidate = EligibleCandidate | TechnicalCandidate;
export type ScanCandidate = RejectedCandidate | BuildableCandidate;

export type ScanResult = {
  scannedAt: Date;
  runtime: ScannerRuntime;
  candidates: ScanCandidate[];
};

export function isEligibleCandidate(
  candidate: ScanCandidate,
): candidate is EligibleCandidate {
  return candidate.status === "eligible";
}

export function isBuildableCandidate(
  candidate: ScanCandidate,
): candidate is BuildableCandidate {
  return candidate.status === "eligible" || candidate.status === "technical";
}

export function selectWsolReserve(
  market: KaminoMarket,
  config: BotConfig,
): KaminoReserve {
  const reserve = config.kaminoWsolReserve
    ? market.getReserveByAddress(config.kaminoWsolReserve)
    : market.getReserveByMint(WSOL_MINT);
  if (!reserve) {
    throw new Error(
      config.kaminoWsolReserve
        ? `Configured KAMINO_WSOL_RESERVE ${config.kaminoWsolReserve.toBase58()} is not in KAMINO_LENDING_MARKET`
        : "Could not find a WSOL reserve in KAMINO_LENDING_MARKET; set KAMINO_WSOL_RESERVE explicitly",
    );
  }
  if (!reserve.getLiquidityMint().equals(WSOL_MINT)) {
    throw new Error(
      `Configured Kamino reserve ${reserve.address.toBase58()} does not use the WSOL native mint`,
    );
  }
  return reserve;
}

function routeLabels(quote: JupiterQuote): string[] {
  return quote.routePlan
    .map((route) => route.swapInfo.label ?? route.swapInfo.ammKey)
    .filter((label, index, labels) => labels.indexOf(label) === index);
}

function rejectedForStrategy(
  strategy: FlashRedeemStrategy,
  reason: string,
  decimals?: number,
): RejectedCandidate[] {
  return strategy.borrowAmountsRaw.map((borrowRaw) => ({
    status: "rejected" as const,
    strategy,
    borrowRaw,
    reason,
    poolTokenDecimals: decimals,
  }));
}

async function scanStrategy(args: {
  connection: Connection;
  wallet: PublicKey;
  config: BotConfig;
  runtime: ScannerRuntime;
  strategy: FlashRedeemStrategy;
}): Promise<ScanCandidate[]> {
  const { connection, wallet, config, runtime, strategy } = args;
  let pool: LoadedStakePool;
  try {
    pool = await loadStakePool(connection, strategy.stakePool);
    if (!pool.state.poolMint.equals(strategy.lstMint)) {
      return rejectedForStrategy(
        strategy,
        `Stake-pool mint ${pool.state.poolMint.toBase58()} does not match whitelisted LST mint ${strategy.lstMint.toBase58()}`,
        pool.poolTokenDecimals,
      );
    }
    assertStakePoolEpochFresh(pool);
    assertSolWithdrawPermission(pool, wallet);
  } catch (error) {
    return rejectedForStrategy(strategy, (error as Error).message);
  }

  const candidates: ScanCandidate[] = [];
  for (const borrowRaw of strategy.borrowAmountsRaw) {
    if (runtime.availableLiquidityRaw < borrowRaw) {
      candidates.push({
        status: "rejected",
        strategy,
        borrowRaw,
        poolTokenDecimals: pool.poolTokenDecimals,
        reason: `Kamino WSOL liquidity ${formatAtomic(runtime.availableLiquidityRaw, SOL_DECIMALS)} is below borrow amount`,
      });
      continue;
    }

    try {
      const quote = await getJupiterQuote(
        config,
        WSOL_MINT,
        strategy.lstMint,
        borrowRaw,
      );
      if (
        quote.inputMint !== WSOL_MINT.toBase58() ||
        quote.outputMint !== strategy.lstMint.toBase58()
      ) {
        throw new Error(
          "Jupiter returned a quote with unexpected input or output mint",
        );
      }
      if (quote.inAmount !== borrowRaw.toString()) {
        throw new Error(
          "Jupiter quote input differs from the requested flash-borrow amount",
        );
      }

      const quoteOutRaw = BigInt(quote.outAmount);
      const quoteMinimumOutRaw = BigInt(quote.otherAmountThreshold);
      if (quoteMinimumOutRaw === 0n)
        throw new Error("Jupiter minimum LST output is zero");

      // Burn the slippage-protected minimum, not the optimistic quote output.
      // This leaves any positive quote improvement in the LST ATA and ensures the
      // same amount can be redeemed even if Jupiter lands at its threshold.
      const lstToBurnRaw = quoteMinimumOutRaw;
      const expectedWithdrawRaw = estimateWithdrawSolLamports(
        pool.state,
        lstToBurnRaw,
      );
      const economics = calculateRedemptionEconomics({
        reserve: runtime.reserve,
        borrowRaw,
        expectedWithdrawRaw,
        config,
      });

      if (
        economics.flashFeeRaw * 10_000n >
        borrowRaw * BigInt(config.maxFlashFeeBps)
      ) {
        throw new Error(
          `Kamino flash fee ${formatAtomic(economics.flashFeeRaw, SOL_DECIMALS)} exceeds MAX_FLASH_FEE_BPS for this borrow size`,
        );
      }
      if (pool.reserveLamports < expectedWithdrawRaw) {
        throw new Error(
          `Stake-pool reserve ${formatAtomic(pool.reserveLamports, SOL_DECIMALS)} cannot fund expected instant redemption`,
        );
      }
      // Technical simulation may bypass only the configured cost/profit margin,
      // never the basic ability to repay the flash loan from protected proceeds.
      if (expectedWithdrawRaw < economics.flashRepaymentRaw) {
        throw new Error(
          `Expected WithdrawSol ${formatAtomic(expectedWithdrawRaw, SOL_DECIMALS)} cannot cover flash repayment ${formatAtomic(economics.flashRepaymentRaw, SOL_DECIMALS)}`,
        );
      }
      const quotedCandidate: QuotedCandidate = {
        strategy,
        borrowRaw,
        pool,
        quote,
        quoteOutRaw,
        quoteMinimumOutRaw,
        lstToBurnRaw,
        expectedWithdrawRaw,
        economics,
        routeLabels: routeLabels(quote),
      };
      if (expectedWithdrawRaw < economics.minimumWithdrawRaw) {
        candidates.push({
          status: "technical",
          ...quotedCandidate,
          economicGateReason: `Expected WithdrawSol ${formatAtomic(expectedWithdrawRaw, SOL_DECIMALS)} is below dynamic repayment/profit gate ${formatAtomic(economics.minimumWithdrawRaw, SOL_DECIMALS)}`,
        });
        continue;
      }

      candidates.push({ status: "eligible", ...quotedCandidate });
    } catch (error) {
      candidates.push({
        status: "rejected",
        strategy,
        borrowRaw,
        poolTokenDecimals: pool.poolTokenDecimals,
        reason: (error as Error).message,
      });
    }
  }
  return candidates;
}

/**
 * Quotes every enabled whitelist strategy serially to avoid overrunning a public
 * RPC/Jupiter rate limit. The result is analysis-only and never signs or sends.
 */
export async function scanFlashRedeemOpportunities(args: {
  connection: Connection;
  wallet: Keypair;
  config: BotConfig;
  strategies: FlashRedeemStrategy[];
}): Promise<ScanResult> {
  const { connection, wallet, config, strategies } = args;
  const [walletBalance, market] = await Promise.all([
    connection.getBalance(wallet.publicKey, "processed"),
    KaminoMarket.load(connection, config.kaminoLendingMarket, 400, PROGRAM_ID),
  ]);
  if (!market)
    throw new Error(
      `Kamino lending market ${config.kaminoLendingMarket.toBase58()} was not found`,
    );

  const reserve = selectWsolReserve(market, config);
  const runtime: ScannerRuntime = {
    market,
    reserve,
    availableLiquidityRaw: BigInt(
      reserve.getLiquidityAvailableAmount().floor().toFixed(0),
    ),
    walletBalanceRaw: BigInt(walletBalance),
  };

  const candidates: ScanCandidate[] = [];
  for (const strategy of strategies.filter((item) => item.enabled)) {
    candidates.push(
      ...(await scanStrategy({
        connection,
        wallet: wallet.publicKey,
        config,
        runtime,
        strategy,
      })),
    );
  }
  return { scannedAt: new Date(), runtime, candidates };
}

export function rankEligibleCandidates(
  candidates: ScanCandidate[],
): EligibleCandidate[] {
  return candidates.filter(isEligibleCandidate).sort((left, right) => {
    if (
      left.economics.expectedNetAfterBudgetRaw ===
      right.economics.expectedNetAfterBudgetRaw
    )
      return 0;
    return left.economics.expectedNetAfterBudgetRaw >
      right.economics.expectedNetAfterBudgetRaw
      ? -1
      : 1;
  });
}

/** Economic candidates that are explicitly approved for LST plan/simulation/execution. */
export function rankExecutionEligibleCandidates(
  candidates: ScanCandidate[],
): EligibleCandidate[] {
  return rankEligibleCandidates(candidates).filter(
    (candidate) => candidate.strategy.mode === "execution",
  );
}

/**
 * Execution-mode candidates that pass every structural safety check and can be
 * assembled into an exact, no-send technical simulation. This intentionally
 * includes candidates below the profitability gate.
 */
export function rankTechnicalSimulationCandidates(
  candidates: ScanCandidate[],
): BuildableCandidate[] {
  return candidates
    .filter(isBuildableCandidate)
    .filter((candidate) => candidate.strategy.mode === "execution")
    .sort((left, right) => {
      if (
        left.economics.expectedNetAfterBudgetRaw ===
        right.economics.expectedNetAfterBudgetRaw
      )
        return 0;
      return left.economics.expectedNetAfterBudgetRaw >
        right.economics.expectedNetAfterBudgetRaw
        ? -1
        : 1;
    });
}

function assertSimulationBalance(scan: ScanResult, config: BotConfig): void {
  if (scan.runtime.walletBalanceRaw < config.minGasBalanceRaw) {
    throw new Error(
      `Wallet needs at least ${formatAtomic(config.minGasBalanceRaw, SOL_DECIMALS)} SOL available for ATA rent and transaction fees; simulation does not spend it`,
    );
  }
}

export function requireBestCandidate(
  scan: ScanResult,
  config: BotConfig,
): EligibleCandidate {
  assertSimulationBalance(scan, config);
  const best = rankExecutionEligibleCandidates(scan.candidates)[0];
  if (!best) {
    throw new Error(
      "No economically eligible execution-mode flash-redemption candidate in this scan",
    );
  }
  return best;
}

/**
 * Selects an execution-mode candidate for `simulate:technical` only. The
 * caller cannot use this selection for a send because send paths select via
 * requireBestCandidate instead.
 */
export function requireBestTechnicalSimulationCandidate(
  scan: ScanResult,
  config: BotConfig,
): BuildableCandidate {
  assertSimulationBalance(scan, config);
  const best = rankTechnicalSimulationCandidates(scan.candidates)[0];
  if (!best) {
    throw new Error(
      "No structurally valid execution-mode flash-redemption candidate for technical simulation in this scan",
    );
  }
  return best;
}
