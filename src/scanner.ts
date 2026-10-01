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

export type EligibleCandidate = {
  status: "eligible";
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

export type ScanCandidate = RejectedCandidate | EligibleCandidate;

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

function selectWsolReserve(
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
      if (expectedWithdrawRaw < economics.minimumWithdrawRaw) {
        throw new Error(
          `Expected WithdrawSol ${formatAtomic(expectedWithdrawRaw, SOL_DECIMALS)} is below dynamic repayment/profit gate ${formatAtomic(economics.minimumWithdrawRaw, SOL_DECIMALS)}`,
        );
      }

      candidates.push({
        status: "eligible",
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
      });
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

export function requireBestCandidate(
  scan: ScanResult,
  config: BotConfig,
): EligibleCandidate {
  if (scan.runtime.walletBalanceRaw < config.minGasBalanceRaw) {
    throw new Error(
      `Wallet needs at least ${formatAtomic(config.minGasBalanceRaw, SOL_DECIMALS)} SOL for ATA rent and transaction fees`,
    );
  }
  const best = rankEligibleCandidates(scan.candidates)[0];
  if (!best) {
    throw new Error(
      "No economically eligible flash-redemption candidate in this scan",
    );
  }
  return best;
}
