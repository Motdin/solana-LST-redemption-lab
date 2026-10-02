import {
  KaminoMarket,
  PROGRAM_ID,
  type KaminoReserve,
} from "@kamino-finance/klend-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { formatAtomic } from "./amount.js";
import { type BotConfig, SOL_DECIMALS, WSOL_MINT } from "./config.js";
import {
  calculateFlashArbEconomics,
  type FlashArbEconomics,
} from "./economics.js";
import { getJupiterQuote, type JupiterQuote } from "./jupiter.js";
import type { PairArbStrategy } from "./pair-strategies.js";
import { selectWsolReserve } from "./scanner.js";
import { TOKEN_PROGRAM_ID } from "./token.js";

export type PairScannerRuntime = {
  market: KaminoMarket;
  reserve: KaminoReserve;
  availableLiquidityRaw: bigint;
};

export type PairRejectedCandidate = {
  status: "rejected";
  strategy: PairArbStrategy;
  borrowRaw: bigint;
  reason: string;
};

/**
 * A fully quoted two-leg cycle. It is diagnostic data only: this module does
 * not ask Jupiter for instructions, construct a transaction, load a keypair,
 * sign, simulate, or send.
 */
export type PairObservation = {
  status: "observed";
  strategy: PairArbStrategy;
  borrowRaw: bigint;
  intermediateDecimals: number;
  firstQuote: JupiterQuote;
  secondQuote: JupiterQuote;
  protectedIntermediateRaw: bigint;
  protectedFinalWsolRaw: bigint;
  economics: FlashArbEconomics;
  passesEconomicGate: boolean;
  legOneRouteLabels: string[];
  legTwoRouteLabels: string[];
};

export type PairScanCandidate = PairRejectedCandidate | PairObservation;

export type PairScanResult = {
  scannedAt: Date;
  runtime: PairScannerRuntime;
  candidates: PairScanCandidate[];
};

export function isPairObservation(
  candidate: PairScanCandidate,
): candidate is PairObservation {
  return candidate.status === "observed";
}

async function loadLegacyMintDecimals(
  connection: Connection,
  mint: PublicKey,
): Promise<number> {
  const account = await connection.getAccountInfo(mint, "processed");
  if (!account)
    throw new Error(`Intermediate mint ${mint.toBase58()} does not exist`);
  if (!account.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(
      `Intermediate mint ${mint.toBase58()} is not owned by the legacy SPL Token program; Token-2022 assets are intentionally excluded from this observer`,
    );
  }
  // The common mint layout places decimals in byte 44. This check excludes an
  // arbitrary account before reading that field.
  if (account.data.length < 45) {
    throw new Error(
      `Intermediate mint ${mint.toBase58()} has an invalid SPL Mint layout`,
    );
  }
  const decimals = account.data[44];
  if (decimals === undefined)
    throw new Error(`Could not read decimals for ${mint.toBase58()}`);
  return decimals;
}

function exactLabels(
  quote: JupiterQuote,
  allowedDexes: readonly string[],
  leg: string,
): string[] {
  if (quote.routePlan.length === 0)
    throw new Error(`Jupiter ${leg} quote has no route plan`);
  const allowed = new Set(allowedDexes.map((dex) => dex.toLowerCase()));
  const labels = quote.routePlan.map((route) => route.swapInfo.label);
  for (const label of labels) {
    if (!label || !allowed.has(label.toLowerCase())) {
      throw new Error(
        `Jupiter ${leg} quote included an unapproved or unlabeled venue ${label ?? "(unknown)"}`,
      );
    }
  }
  return labels.filter(
    (label, index): label is string =>
      Boolean(label) && labels.indexOf(label) === index,
  );
}

function assertExactInQuote(args: {
  quote: JupiterQuote;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputRaw: bigint;
  leg: string;
}): void {
  const { quote, inputMint, outputMint, inputRaw, leg } = args;
  if (
    quote.inputMint !== inputMint.toBase58() ||
    quote.outputMint !== outputMint.toBase58()
  ) {
    throw new Error(`Jupiter ${leg} quote has unexpected input or output mint`);
  }
  if (quote.inAmount !== inputRaw.toString()) {
    throw new Error(
      `Jupiter ${leg} quote input differs from the requested amount`,
    );
  }
  if (BigInt(quote.otherAmountThreshold) === 0n) {
    throw new Error(`Jupiter ${leg} quote has zero protected output`);
  }
}

function rejectedForStrategy(
  strategy: PairArbStrategy,
  reason: string,
): PairRejectedCandidate[] {
  return strategy.borrowAmountsRaw.map((borrowRaw) => ({
    status: "rejected" as const,
    strategy,
    borrowRaw,
    reason,
  }));
}

async function scanStrategy(args: {
  connection: Connection;
  config: BotConfig;
  runtime: PairScannerRuntime;
  strategy: PairArbStrategy;
}): Promise<PairScanCandidate[]> {
  const { connection, config, runtime, strategy } = args;
  let intermediateDecimals: number;
  try {
    intermediateDecimals = await loadLegacyMintDecimals(
      connection,
      strategy.intermediateMint,
    );
  } catch (error) {
    return rejectedForStrategy(strategy, (error as Error).message);
  }

  const candidates: PairScanCandidate[] = [];
  for (const borrowRaw of strategy.borrowAmountsRaw) {
    if (runtime.availableLiquidityRaw < borrowRaw) {
      candidates.push({
        status: "rejected",
        strategy,
        borrowRaw,
        reason: `Kamino WSOL liquidity ${formatAtomic(runtime.availableLiquidityRaw, SOL_DECIMALS)} is below borrow amount`,
      });
      continue;
    }

    try {
      const firstQuote = await getJupiterQuote(
        config,
        WSOL_MINT,
        strategy.intermediateMint,
        borrowRaw,
        { dexes: strategy.legOneDexes, onlyDirectRoutes: true },
      );
      assertExactInQuote({
        quote: firstQuote,
        inputMint: WSOL_MINT,
        outputMint: strategy.intermediateMint,
        inputRaw: borrowRaw,
        leg: "leg one",
      });
      const legOneRouteLabels = exactLabels(
        firstQuote,
        strategy.legOneDexes,
        "leg one",
      );

      // The second quote spends only the first leg's protected minimum. Any
      // positive first-leg improvement is deliberately ignored as unvalued dust.
      const protectedIntermediateRaw = BigInt(firstQuote.otherAmountThreshold);
      const secondQuote = await getJupiterQuote(
        config,
        strategy.intermediateMint,
        WSOL_MINT,
        protectedIntermediateRaw,
        { dexes: strategy.legTwoDexes, onlyDirectRoutes: true },
      );
      assertExactInQuote({
        quote: secondQuote,
        inputMint: strategy.intermediateMint,
        outputMint: WSOL_MINT,
        inputRaw: protectedIntermediateRaw,
        leg: "leg two",
      });
      const legTwoRouteLabels = exactLabels(
        secondQuote,
        strategy.legTwoDexes,
        "leg two",
      );

      const protectedFinalWsolRaw = BigInt(secondQuote.otherAmountThreshold);
      const economics = calculateFlashArbEconomics({
        reserve: runtime.reserve,
        borrowRaw,
        expectedFinalOutputRaw: protectedFinalWsolRaw,
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

      candidates.push({
        status: "observed",
        strategy,
        borrowRaw,
        intermediateDecimals,
        firstQuote,
        secondQuote,
        protectedIntermediateRaw,
        protectedFinalWsolRaw,
        economics,
        passesEconomicGate:
          protectedFinalWsolRaw >= economics.minimumFinalOutputRaw,
        legOneRouteLabels,
        legTwoRouteLabels,
      });
    } catch (error) {
      candidates.push({
        status: "rejected",
        strategy,
        borrowRaw,
        reason: (error as Error).message,
      });
    }
  }
  return candidates;
}

/**
 * Read-only pair observer. It obtains two protected ExactIn quotes, reads the
 * current Kamino WSOL flash fee/liquidity, and performs no instruction request,
 * transaction construction, signing, simulation, or send.
 */
export async function scanPairArbOpportunities(args: {
  connection: Connection;
  config: BotConfig;
  strategies: PairArbStrategy[];
}): Promise<PairScanResult> {
  const { connection, config, strategies } = args;
  const market = await KaminoMarket.load(
    connection,
    config.kaminoLendingMarket,
    400,
    PROGRAM_ID,
  );
  if (!market) {
    throw new Error(
      `Kamino lending market ${config.kaminoLendingMarket.toBase58()} was not found`,
    );
  }
  const reserve = selectWsolReserve(market, config);
  const runtime: PairScannerRuntime = {
    market,
    reserve,
    availableLiquidityRaw: BigInt(
      reserve.getLiquidityAvailableAmount().floor().toFixed(0),
    ),
  };

  const candidates: PairScanCandidate[] = [];
  for (const strategy of strategies.filter((strategy) => strategy.enabled)) {
    candidates.push(
      ...(await scanStrategy({ connection, config, runtime, strategy })),
    );
  }
  return { scannedAt: new Date(), runtime, candidates };
}

/** Rank positive-gate observations first, then highest protected net output. */
export function rankPairObservations(
  candidates: PairScanCandidate[],
): PairObservation[] {
  return candidates.filter(isPairObservation).sort((left, right) => {
    if (left.passesEconomicGate !== right.passesEconomicGate) {
      return left.passesEconomicGate ? -1 : 1;
    }
    if (
      left.economics.expectedNetAfterBudgetRaw ===
      right.economics.expectedNetAfterBudgetRaw
    ) {
      return 0;
    }
    return left.economics.expectedNetAfterBudgetRaw >
      right.economics.expectedNetAfterBudgetRaw
      ? -1
      : 1;
  });
}

/**
 * Pair plans are intentionally limited to a current, protected-quote candidate
 * that clears the same repayment/cost/profit gate as the observer. Building a
 * losing cycle just to simulate it is refused.
 */
export function requireBestPairCandidate(args: {
  scan: PairScanResult;
  config: BotConfig;
  walletBalanceRaw: bigint;
}): PairObservation {
  const { scan, config, walletBalanceRaw } = args;
  if (walletBalanceRaw < config.minGasBalanceRaw) {
    throw new Error(
      `Wallet needs at least ${formatAtomic(config.minGasBalanceRaw, SOL_DECIMALS)} SOL for ATA rent and transaction fees`,
    );
  }
  const best = rankPairObservations(scan.candidates).find(
    (candidate) => candidate.passesEconomicGate,
  );
  if (!best) {
    throw new Error(
      "No economically eligible pair candidate in this scan; pair planning and simulation remain disabled",
    );
  }
  return best;
}
