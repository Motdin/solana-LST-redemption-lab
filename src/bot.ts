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
  PROGRAM_ID,
  getFlashLoanInstructions,
} from "@kamino-finance/klend-sdk";
import { formatAtomic, toSafeNumber } from "./amount.js";
import { type BotConfig, SOL_DECIMALS, WSOL_MINT } from "./config.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  deriveAssociatedTokenAddress,
} from "./token.js";
import { getJupiterSwapPlan } from "./jupiter.js";
import {
  buildUpdateStakePoolBalanceInstruction,
  buildWithdrawSolInstruction,
} from "./stake-pool.js";
import type { EligibleCandidate, ScannerRuntime } from "./scanner.js";

export type FlashRedeemPlan = {
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  strategyId: string;
  flashBorrowInstructionIndex: number;
  flashBorrowRaw: bigint;
  flashFeeRaw: bigint;
  flashRepaymentRaw: bigint;
  quoteOutRaw: bigint;
  quoteMinimumOutRaw: bigint;
  lstToBurnRaw: bigint;
  lstDecimals: number;
  expectedWithdrawRaw: bigint;
  expectedNetBeforeNetworkRaw: bigint;
  expectedNetAfterBudgetRaw: bigint;
  targetMinimumWithdrawRaw: bigint;
  instructions: TransactionInstruction[];
  routeLabels: string[];
  reserve: string;
  stakePool: string;
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

/**
 * Builds the exact top-ranked scanner candidate. The candidate burns Jupiter's
 * slippage-protected LST minimum, so its economic estimate is conservative.
 */
export async function buildFlashRedeemPlan(args: {
  connection: Connection;
  wallet: Keypair;
  config: BotConfig;
  runtime: ScannerRuntime;
  candidate: EligibleCandidate;
}): Promise<FlashRedeemPlan> {
  const { connection, wallet, config, runtime, candidate } = args;
  const walletAddress = wallet.publicKey;
  const { pool, strategy } = candidate;

  assert(
    candidate.quote.inputMint === WSOL_MINT.toBase58() &&
      candidate.quote.outputMint === strategy.lstMint.toBase58(),
    "Scanner candidate has mismatched Jupiter mints",
  );
  assert(
    candidate.quote.inAmount === candidate.borrowRaw.toString(),
    "Scanner candidate has mismatched Jupiter input",
  );
  assert(
    candidate.quoteMinimumOutRaw === candidate.lstToBurnRaw,
    "Scanner candidate must burn its protected Jupiter minimum",
  );

  const wsolTokenProgram = runtime.reserve.getLiquidityTokenProgram();
  const wsolAta = deriveAssociatedTokenAddress(
    WSOL_MINT,
    walletAddress,
    wsolTokenProgram,
  );
  const lstAta = deriveAssociatedTokenAddress(
    strategy.lstMint,
    walletAddress,
    pool.state.tokenProgramId,
  );
  const swap = await getJupiterSwapPlan({
    config,
    quote: candidate.quote,
    wallet: walletAddress,
    destinationLstAccount: lstAta,
    kaminoProgram: PROGRAM_ID,
  });

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
      mint: strategy.lstMint,
      tokenProgram: pool.state.tokenProgramId,
    }),
  ];
  const flashBorrowInstructionIndex = preInstructions.length;
  const { flashBorrowIxn, flashRepayIxn } = getFlashLoanInstructions({
    borrowIxnIndex: flashBorrowInstructionIndex,
    walletPublicKey: walletAddress,
    lendingMarketAuthority: runtime.market.getLendingMarketAuthority(),
    lendingMarketAddress: runtime.market.getAddress(),
    reserve: runtime.reserve,
    amountLamports: new Decimal(candidate.borrowRaw.toString()),
    destinationAta: wsolAta,
    // klend's legacy web3 interface uses the lending-program ID as the no-referrer sentinel.
    referrerAccount: runtime.market.programId,
    referrerTokenState: runtime.market.programId,
    programId: PROGRAM_ID,
  });

  const instructions = [
    ...preInstructions,
    flashBorrowIxn,
    ...swap.setupInstructions,
    ...swap.swapInstructions,
    buildUpdateStakePoolBalanceInstruction(pool),
    buildWithdrawSolInstruction({
      pool,
      wallet: walletAddress,
      sourceLstAccount: lstAta,
      poolTokens: candidate.lstToBurnRaw,
    }),
    SystemProgram.transfer({
      fromPubkey: walletAddress,
      toPubkey: wsolAta,
      lamports: toSafeNumber(
        candidate.economics.flashRepaymentRaw,
        "Kamino repayment",
      ),
    }),
    createSyncNativeInstruction(wsolAta, wsolTokenProgram),
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
    strategyId: strategy.id,
    flashBorrowInstructionIndex,
    flashBorrowRaw: candidate.borrowRaw,
    flashFeeRaw: candidate.economics.flashFeeRaw,
    flashRepaymentRaw: candidate.economics.flashRepaymentRaw,
    quoteOutRaw: candidate.quoteOutRaw,
    quoteMinimumOutRaw: candidate.quoteMinimumOutRaw,
    lstToBurnRaw: candidate.lstToBurnRaw,
    lstDecimals: pool.poolTokenDecimals,
    expectedWithdrawRaw: candidate.expectedWithdrawRaw,
    expectedNetBeforeNetworkRaw:
      candidate.economics.expectedNetBeforeNetworkRaw,
    expectedNetAfterBudgetRaw: candidate.economics.expectedNetAfterBudgetRaw,
    targetMinimumWithdrawRaw: candidate.economics.minimumWithdrawRaw,
    instructions,
    routeLabels: swap.routeLabels,
    reserve: runtime.reserve.address.toBase58(),
    stakePool: pool.address.toBase58(),
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
      skipPreflight: true,
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
    Strategy: plan.strategyId,
    "Kamino WSOL reserve": plan.reserve,
    "LST stake pool": plan.stakePool,
    "Flash borrow": `${formatAtomic(plan.flashBorrowRaw, SOL_DECIMALS)} WSOL`,
    "Kamino flash fee (on-chain)": `${formatAtomic(plan.flashFeeRaw, SOL_DECIMALS)} WSOL`,
    "Flash repayment": `${formatAtomic(plan.flashRepaymentRaw, SOL_DECIMALS)} WSOL`,
    "Jupiter quote output": `${formatAtomic(plan.quoteOutRaw, plan.lstDecimals)} LST`,
    "Jupiter protected output": `${formatAtomic(plan.quoteMinimumOutRaw, plan.lstDecimals)} LST`,
    "LST burned": `${formatAtomic(plan.lstToBurnRaw, plan.lstDecimals)} LST`,
    "WithdrawSol expected": `${formatAtomic(plan.expectedWithdrawRaw, SOL_DECIMALS)} SOL`,
    "Dynamic repayment/profit gate": `${formatAtomic(plan.targetMinimumWithdrawRaw, SOL_DECIMALS)} SOL`,
    "Expected net before network": `${formatAtomic(plan.expectedNetBeforeNetworkRaw, SOL_DECIMALS)} SOL`,
    "Expected net after fee budget": `${formatAtomic(plan.expectedNetAfterBudgetRaw, SOL_DECIMALS)} SOL`,
    "Kamino borrow instruction index": plan.flashBorrowInstructionIndex,
    "Jupiter route": plan.routeLabels,
    "Instruction count": plan.instructions.length,
  };
}
