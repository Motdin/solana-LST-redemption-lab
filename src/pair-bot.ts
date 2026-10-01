import { Decimal } from "decimal.js";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  PROGRAM_ID,
  getFlashLoanInstructions,
} from "@kamino-finance/klend-sdk";
import { formatAtomic } from "./amount.js";
import { type BotConfig, SOL_DECIMALS, WSOL_MINT } from "./config.js";
import { getJupiterSwapPlan } from "./jupiter.js";
import {
  type PairObservation,
  type PairScannerRuntime,
} from "./pair-scanner.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  deriveAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "./token.js";

export type FlashPairPlan = {
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  strategyId: string;
  flashBorrowInstructionIndex: number;
  flashBorrowRaw: bigint;
  flashFeeRaw: bigint;
  flashRepaymentRaw: bigint;
  protectedIntermediateRaw: bigint;
  intermediateDecimals: number;
  protectedFinalWsolRaw: bigint;
  targetMinimumFinalWsolRaw: bigint;
  expectedNetBeforeNetworkRaw: bigint;
  expectedNetAfterBudgetRaw: bigint;
  instructions: TransactionInstruction[];
  firstRouteLabels: string[];
  secondRouteLabels: string[];
  reserve: string;
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

function uniqueLookupTableAddresses(addresses: PublicKey[]): PublicKey[] {
  const unique = new Map<string, PublicKey>();
  for (const address of addresses) unique.set(address.toBase58(), address);
  return [...unique.values()];
}

function assertPairCandidate(candidate: PairObservation): void {
  const { strategy } = candidate;
  assert(
    candidate.firstQuote.inputMint === WSOL_MINT.toBase58() &&
      candidate.firstQuote.outputMint === strategy.intermediateMint.toBase58(),
    "Pair candidate has mismatched leg-one Jupiter mints",
  );
  assert(
    candidate.firstQuote.inAmount === candidate.borrowRaw.toString(),
    "Pair candidate has mismatched leg-one Jupiter input",
  );
  assert(
    BigInt(candidate.firstQuote.otherAmountThreshold) ===
      candidate.protectedIntermediateRaw,
    "Pair candidate has mismatched protected intermediate output",
  );
  assert(
    candidate.secondQuote.inputMint === strategy.intermediateMint.toBase58() &&
      candidate.secondQuote.outputMint === WSOL_MINT.toBase58(),
    "Pair candidate has mismatched leg-two Jupiter mints",
  );
  assert(
    candidate.secondQuote.inAmount ===
      candidate.protectedIntermediateRaw.toString(),
    "Pair candidate must spend exactly the protected leg-one output",
  );
  assert(
    BigInt(candidate.secondQuote.otherAmountThreshold) ===
      candidate.protectedFinalWsolRaw,
    "Pair candidate has mismatched protected final WSOL output",
  );
  assert(
    candidate.passesEconomicGate,
    "Refusing to build a pair candidate that does not clear the economic gate",
  );
}

/**
 * Builds, signs locally, and returns a two-swap flash-loan transaction for an
 * already-qualified pair observation. This module deliberately exports no send
 * path: callers may inspect or simulate the transaction only.
 */
export async function buildFlashPairPlan(args: {
  connection: Connection;
  wallet: Keypair;
  config: BotConfig;
  runtime: PairScannerRuntime;
  candidate: PairObservation;
}): Promise<FlashPairPlan> {
  const { connection, wallet, config, runtime, candidate } = args;
  assertPairCandidate(candidate);

  const walletAddress = wallet.publicKey;
  const wsolTokenProgram = runtime.reserve.getLiquidityTokenProgram();
  const wsolAta = deriveAssociatedTokenAddress(
    WSOL_MINT,
    walletAddress,
    wsolTokenProgram,
  );
  // Pair scanning intentionally accepts only legacy SPL intermediate mints.
  const intermediateAta = deriveAssociatedTokenAddress(
    candidate.strategy.intermediateMint,
    walletAddress,
    TOKEN_PROGRAM_ID,
  );

  const [firstSwap, secondSwap] = await Promise.all([
    getJupiterSwapPlan({
      config,
      quote: candidate.firstQuote,
      wallet: walletAddress,
      destinationTokenAccount: intermediateAta,
      kaminoProgram: PROGRAM_ID,
    }),
    getJupiterSwapPlan({
      config,
      quote: candidate.secondQuote,
      wallet: walletAddress,
      destinationTokenAccount: wsolAta,
      kaminoProgram: PROGRAM_ID,
    }),
  ]);

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
      associatedToken: intermediateAta,
      owner: walletAddress,
      mint: candidate.strategy.intermediateMint,
      tokenProgram: TOKEN_PROGRAM_ID,
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
    ...firstSwap.setupInstructions,
    ...firstSwap.swapInstructions,
    ...secondSwap.setupInstructions,
    ...secondSwap.swapInstructions,
    flashRepayIxn,
  ];
  assert(
    instructions[flashBorrowInstructionIndex]?.programId.equals(PROGRAM_ID),
    "Internal error: Kamino borrow instruction index no longer matches the compiled pair flow",
  );

  const lookupTableAddresses = uniqueLookupTableAddresses([
    ...firstSwap.lookupTableAddresses,
    ...secondSwap.lookupTableAddresses,
  ]);
  const [lookupTables, latestBlockhash] = await Promise.all([
    getLookupTables(connection, lookupTableAddresses),
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
    strategyId: candidate.strategy.id,
    flashBorrowInstructionIndex,
    flashBorrowRaw: candidate.borrowRaw,
    flashFeeRaw: candidate.economics.flashFeeRaw,
    flashRepaymentRaw: candidate.economics.flashRepaymentRaw,
    protectedIntermediateRaw: candidate.protectedIntermediateRaw,
    intermediateDecimals: candidate.intermediateDecimals,
    protectedFinalWsolRaw: candidate.protectedFinalWsolRaw,
    targetMinimumFinalWsolRaw: candidate.economics.minimumFinalOutputRaw,
    expectedNetBeforeNetworkRaw:
      candidate.economics.expectedNetBeforeNetworkRaw,
    expectedNetAfterBudgetRaw: candidate.economics.expectedNetAfterBudgetRaw,
    instructions,
    firstRouteLabels: firstSwap.routeLabels,
    secondRouteLabels: secondSwap.routeLabels,
    reserve: runtime.reserve.address.toBase58(),
  };
}

export async function simulateFlashPairPlan(
  connection: Connection,
  plan: FlashPairPlan,
): Promise<{ unitsConsumed?: number; logs: string[] }> {
  const simulation = await connection.simulateTransaction(plan.transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs ?? [];
    throw new Error(
      `Pair simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs.join("\n")}`,
    );
  }
  return {
    unitsConsumed: simulation.value.unitsConsumed,
    logs: simulation.value.logs ?? [],
  };
}

export function pairPlanSummary(
  plan: FlashPairPlan,
): Record<string, string | number | string[]> {
  return {
    Strategy: plan.strategyId,
    "Kamino WSOL reserve": plan.reserve,
    "Flash borrow": `${formatAtomic(plan.flashBorrowRaw, SOL_DECIMALS)} WSOL`,
    "Kamino flash fee (on-chain)": `${formatAtomic(plan.flashFeeRaw, SOL_DECIMALS)} WSOL`,
    "Flash repayment": `${formatAtomic(plan.flashRepaymentRaw, SOL_DECIMALS)} WSOL`,
    "Protected intermediate": `${formatAtomic(plan.protectedIntermediateRaw, plan.intermediateDecimals)}`,
    "Protected final WSOL": `${formatAtomic(plan.protectedFinalWsolRaw, SOL_DECIMALS)} WSOL`,
    "Dynamic repayment/profit gate": `${formatAtomic(plan.targetMinimumFinalWsolRaw, SOL_DECIMALS)} WSOL`,
    "Expected net before network": `${formatAtomic(plan.expectedNetBeforeNetworkRaw, SOL_DECIMALS)} WSOL`,
    "Expected net after fee budget": `${formatAtomic(plan.expectedNetAfterBudgetRaw, SOL_DECIMALS)} WSOL`,
    "Kamino borrow instruction index": plan.flashBorrowInstructionIndex,
    "Jupiter leg one route": plan.firstRouteLabels,
    "Jupiter leg two route": plan.secondRouteLabels,
    "Instruction count": plan.instructions.length,
  };
}
