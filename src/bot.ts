import { Decimal } from "decimal.js";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  KaminoMarket,
  PROGRAM_ID,
  getFlashLoanInstructions,
  type KaminoReserve,
} from "@kamino-finance/klend-sdk";
import { formatAtomic, toSafeNumber } from "./amount.js";
import { type BotConfig, SOL_DECIMALS, WSOL_MINT } from "./config.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  deriveAssociatedTokenAddress,
} from "./token.js";
import {
  getJupiterQuote,
  getJupiterSwapPlan,
  type JupiterSwapPlan,
} from "./jupiter.js";
import {
  assertStakePoolEpochFresh,
  buildUpdateStakePoolBalanceInstruction,
  buildWithdrawSolInstruction,
  estimateWithdrawSolLamports,
  loadStakePool,
} from "./stake-pool.js";

export type FlashRedeemPlan = {
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  flashBorrowInstructionIndex: number;
  flashBorrowRaw: bigint;
  flashFeeRaw: bigint;
  flashRepaymentRaw: bigint;
  quoteOutRaw: bigint;
  quoteMinimumOutRaw: bigint;
  lstToBurnRaw: bigint;
  expectedWithdrawRaw: bigint;
  expectedNetProfitBeforeNetworkRaw: bigint;
  targetMinimumWithdrawRaw: bigint;
  instructions: TransactionInstruction[];
  routeLabels: string[];
  wsolAta: PublicKey;
  lstAta: PublicKey;
  reserve: PublicKey;
  stakePool: PublicKey;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function getLookupTables(
  connection: Connection,
  addresses: PublicKey[],
): Promise<AddressLookupTableAccount[]> {
  if (addresses.length === 0) return [];
  const accounts = await connection.getMultipleAccountsInfo(
    addresses,
    "processed",
  );
  return accounts.map((account, index) => {
    const address = addresses[index];
    if (!account || !address) {
      throw new Error(
        `Jupiter address lookup table was not found: ${address?.toBase58() ?? "unknown"}`,
      );
    }
    return new AddressLookupTableAccount({
      key: address,
      state: AddressLookupTableAccount.deserialize(account.data),
    });
  });
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

function calculateFlashFee(reserve: KaminoReserve, borrowRaw: bigint): bigint {
  const fees = reserve.calculateFlashLoanFees(
    new Decimal(borrowRaw.toString()),
    0,
    false,
  );
  // The SDK exposes token amount as Decimal; ceil protects the source ATA from a
  // one-lamport shortfall if the protocol fee has fractional atomic units.
  return BigInt(fees.protocolFees.ceil().toFixed(0));
}

function assertQuoteMatchesFlow(
  swap: JupiterSwapPlan,
  config: BotConfig,
): { quoteOutRaw: bigint; quoteMinimumOutRaw: bigint } {
  const { quote } = swap;
  assert(
    quote.inputMint === WSOL_MINT.toBase58(),
    "Jupiter quote input mint is not WSOL",
  );
  assert(
    quote.outputMint === config.lstMint.toBase58(),
    "Jupiter quote output mint is not the configured marginfi LST",
  );
  assert(
    quote.inAmount === config.flashBorrowRaw.toString(),
    "Jupiter changed the exact WSOL input amount",
  );

  const quoteOutRaw = BigInt(quote.outAmount);
  const quoteMinimumOutRaw = BigInt(quote.otherAmountThreshold);
  assert(
    quoteMinimumOutRaw >= config.minLstOutRaw,
    `Jupiter's slippage-protected LST output ${formatAtomic(quoteMinimumOutRaw, SOL_DECIMALS)} is below MIN_LST_OUT ${formatAtomic(config.minLstOutRaw, SOL_DECIMALS)}`,
  );
  assert(
    quoteMinimumOutRaw >= config.lstToBurnRaw,
    "Jupiter's minimum output does not cover the LST amount that will be burned by WithdrawSol",
  );
  return { quoteOutRaw, quoteMinimumOutRaw };
}

function assertPoolAndProfit(args: {
  poolMint: PublicKey;
  estimatedWithdrawRaw: bigint;
  reserveLamports: bigint;
  config: BotConfig;
  repaymentRaw: bigint;
}): bigint {
  const {
    poolMint,
    estimatedWithdrawRaw,
    reserveLamports,
    config,
    repaymentRaw,
  } = args;
  if (!poolMint.equals(config.lstMint)) {
    throw new Error(
      `STAKE_POOL_ADDRESS pool mint ${poolMint.toBase58()} does not match LST_MINT ${config.lstMint.toBase58()}`,
    );
  }
  const targetMinimumWithdrawRaw = [
    config.minWithdrawSolRaw,
    repaymentRaw + config.minNetProfitRaw + config.maxTxCostRaw,
  ].reduce((maximum, value) => (value > maximum ? value : maximum), 0n);

  assert(
    estimatedWithdrawRaw >= targetMinimumWithdrawRaw,
    `Estimated WithdrawSol output ${formatAtomic(estimatedWithdrawRaw, SOL_DECIMALS)} SOL is below required ${formatAtomic(targetMinimumWithdrawRaw, SOL_DECIMALS)} SOL`,
  );
  assert(
    reserveLamports >= estimatedWithdrawRaw,
    `Stake pool reserve has only ${formatAtomic(reserveLamports, SOL_DECIMALS)} SOL; it cannot fund the expected instant withdrawal`,
  );
  return targetMinimumWithdrawRaw;
}

/**
 * Build one atomic V0 transaction. The important ordering is:
 * setup → flash borrow → Jupiter swap → UpdateStakePoolBalance → WithdrawSol
 * → wrap exact Kamino repayment → flash repay.
 */
export async function buildFlashRedeemPlan(args: {
  connection: Connection;
  wallet: Keypair;
  config: BotConfig;
}): Promise<FlashRedeemPlan> {
  const { connection, wallet, config } = args;
  const walletAddress = wallet.publicKey;

  const [walletLamports, market, pool] = await Promise.all([
    connection.getBalance(walletAddress, "processed"),
    KaminoMarket.load(connection, config.kaminoLendingMarket, 400, PROGRAM_ID),
    loadStakePool(connection, config.stakePool),
  ]);
  assert(
    BigInt(walletLamports) >= config.minGasBalanceRaw,
    `Wallet needs at least ${formatAtomic(config.minGasBalanceRaw, SOL_DECIMALS)} SOL for ATA rent and transaction fees`,
  );
  if (!market)
    throw new Error(
      `Kamino lending market ${config.kaminoLendingMarket.toBase58()} was not found`,
    );

  const reserve = selectWsolReserve(market, config);
  const availableLiquidity = BigInt(
    reserve.getLiquidityAvailableAmount().floor().toFixed(0),
  );
  assert(
    availableLiquidity >= config.flashBorrowRaw,
    `Kamino WSOL reserve has only ${formatAtomic(availableLiquidity, SOL_DECIMALS)} WSOL available`,
  );

  assertStakePoolEpochFresh(pool);
  const expectedWithdrawRaw = estimateWithdrawSolLamports(
    pool.state,
    config.lstToBurnRaw,
  );
  const flashFeeRaw = calculateFlashFee(reserve, config.flashBorrowRaw);
  assert(
    flashFeeRaw <= config.maxFlashFeeRaw,
    `On-chain Kamino flash fee ${formatAtomic(flashFeeRaw, SOL_DECIMALS)} SOL exceeds MAX_FLASH_FEE_SOL`,
  );
  const flashRepaymentRaw = config.flashBorrowRaw + flashFeeRaw;
  const targetMinimumWithdrawRaw = assertPoolAndProfit({
    poolMint: pool.state.poolMint,
    estimatedWithdrawRaw: expectedWithdrawRaw,
    reserveLamports: pool.reserveLamports,
    config,
    repaymentRaw: flashRepaymentRaw,
  });

  const wsolTokenProgram = reserve.getLiquidityTokenProgram();
  const wsolAta = deriveAssociatedTokenAddress(
    WSOL_MINT,
    walletAddress,
    wsolTokenProgram,
  );
  const lstAta = deriveAssociatedTokenAddress(
    config.lstMint,
    walletAddress,
    pool.state.tokenProgramId,
  );

  const quote = await getJupiterQuote(
    config,
    WSOL_MINT,
    config.lstMint,
    config.flashBorrowRaw,
  );
  const swap = await getJupiterSwapPlan({
    config,
    quote,
    wallet: walletAddress,
    destinationLstAccount: lstAta,
    kaminoProgram: PROGRAM_ID,
  });
  const { quoteOutRaw, quoteMinimumOutRaw } = assertQuoteMatchesFlow(
    swap,
    config,
  );

  // Compute budget must occur before all program instructions. Its presence means
  // the Kamino borrow is not instruction 0; the exact index is supplied below.
  const preInstructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: config.computeUnitLimit,
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: config.computeUnitPriceMicroLamports,
    }),
    createAssociatedTokenAccountIdempotentInstruction({
      payer: walletAddress,
      associatedToken: wsolAta,
      owner: walletAddress,
      mint: WSOL_MINT,
      tokenProgram: wsolTokenProgram,
    }),
    createAssociatedTokenAccountIdempotentInstruction({
      payer: walletAddress,
      associatedToken: lstAta,
      owner: walletAddress,
      mint: config.lstMint,
      tokenProgram: pool.state.tokenProgramId,
    }),
  ];
  const flashBorrowInstructionIndex = preInstructions.length;
  const { flashBorrowIxn, flashRepayIxn } = getFlashLoanInstructions({
    borrowIxnIndex: flashBorrowInstructionIndex,
    walletPublicKey: walletAddress,
    lendingMarketAuthority: market.getLendingMarketAuthority(),
    lendingMarketAddress: market.getAddress(),
    reserve,
    amountLamports: new Decimal(config.flashBorrowRaw.toString()),
    destinationAta: wsolAta,
    // klend's legacy web3 interface uses the lending-program ID as the
    // no-referrer sentinel (not the system-program/default key).
    referrerAccount: market.programId,
    referrerTokenState: market.programId,
    programId: PROGRAM_ID,
  });

  const updateStakePoolBalance = buildUpdateStakePoolBalanceInstruction(pool);
  const withdrawSol = buildWithdrawSolInstruction({
    pool,
    wallet: walletAddress,
    sourceLstAccount: lstAta,
    poolTokens: config.lstToBurnRaw,
  });
  const wrapRepayment = SystemProgram.transfer({
    fromPubkey: walletAddress,
    toPubkey: wsolAta,
    lamports: toSafeNumber(flashRepaymentRaw, "Kamino repayment"),
  });
  const syncWrappedSol = createSyncNativeInstruction(wsolAta, wsolTokenProgram);

  const instructions = [
    ...preInstructions,
    flashBorrowIxn,
    ...swap.setupInstructions,
    ...swap.swapInstructions,
    updateStakePoolBalance,
    withdrawSol,
    wrapRepayment,
    syncWrappedSol,
    flashRepayIxn,
  ];
  assert(
    instructions[flashBorrowInstructionIndex]?.programId.equals(PROGRAM_ID),
    "Internal error: Kamino borrow instruction index no longer matches the compiled flow",
  );

  const [lookupTables, latestBlockhash] = await Promise.all([
    getLookupTables(connection, swap.lookupTableAddresses),
    connection.getLatestBlockhash("processed"),
  ]);
  const message = new TransactionMessage({
    payerKey: walletAddress,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([wallet]);

  return {
    transaction,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    flashBorrowInstructionIndex,
    flashBorrowRaw: config.flashBorrowRaw,
    flashFeeRaw,
    flashRepaymentRaw,
    quoteOutRaw,
    quoteMinimumOutRaw,
    lstToBurnRaw: config.lstToBurnRaw,
    expectedWithdrawRaw,
    expectedNetProfitBeforeNetworkRaw: expectedWithdrawRaw - flashRepaymentRaw,
    targetMinimumWithdrawRaw,
    instructions,
    routeLabels: swap.routeLabels,
    wsolAta,
    lstAta,
    reserve: reserve.address,
    stakePool: pool.address,
  };
}

export async function simulatePlan(
  connection: Connection,
  plan: FlashRedeemPlan,
): Promise<{ unitsConsumed?: number; logs: string[] }> {
  const simulation = await connection.simulateTransaction(plan.transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs ?? [];
    throw new Error(
      `Simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs.join("\n")}`,
    );
  }
  return {
    unitsConsumed: simulation.value.unitsConsumed,
    logs: simulation.value.logs ?? [],
  };
}

export async function sendPlan(
  connection: Connection,
  plan: FlashRedeemPlan,
): Promise<string> {
  const signature = await connection.sendRawTransaction(
    plan.transaction.serialize(),
    {
      skipPreflight: true, // Full preflight is performed by simulatePlan immediately before this call.
      maxRetries: 0,
    },
  );
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: plan.blockhash,
      lastValidBlockHeight: plan.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(
      `Transaction ${signature} confirmed with error: ${JSON.stringify(confirmation.value.err)}`,
    );
  }
  return signature;
}

export function planSummary(
  plan: FlashRedeemPlan,
): Record<string, string | number | string[]> {
  return {
    "Kamino WSOL reserve": plan.reserve.toBase58(),
    "Marginfi LST stake pool": plan.stakePool.toBase58(),
    "Flash borrow": `${formatAtomic(plan.flashBorrowRaw, SOL_DECIMALS)} WSOL`,
    "Kamino flash fee (on-chain)": `${formatAtomic(plan.flashFeeRaw, SOL_DECIMALS)} WSOL`,
    "Flash repayment": `${formatAtomic(plan.flashRepaymentRaw, SOL_DECIMALS)} WSOL`,
    "Jupiter quote output": `${formatAtomic(plan.quoteOutRaw, SOL_DECIMALS)} LST`,
    "Jupiter minimum output": `${formatAtomic(plan.quoteMinimumOutRaw, SOL_DECIMALS)} LST`,
    "LST burned": `${formatAtomic(plan.lstToBurnRaw, SOL_DECIMALS)} LST`,
    "WithdrawSol expected": `${formatAtomic(plan.expectedWithdrawRaw, SOL_DECIMALS)} SOL`,
    "Minimum withdrawal gate": `${formatAtomic(plan.targetMinimumWithdrawRaw, SOL_DECIMALS)} SOL`,
    "Expected net before network": `${formatAtomic(plan.expectedNetProfitBeforeNetworkRaw, SOL_DECIMALS)} SOL`,
    "Kamino borrow instruction index": plan.flashBorrowInstructionIndex,
    "Jupiter route": plan.routeLabels,
    "Instruction count": plan.instructions.length,
  };
}
