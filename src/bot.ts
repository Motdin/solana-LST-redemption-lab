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
  type Commitment,
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
import type { BuildableCandidate, ScannerRuntime } from "./scanner.js";

/**
 * On-chain floor passed to `WithdrawSolWithSlippage` for `candidate`.
 *
 * An economic candidate must clear the whole repayment + cost + profit gate on
 * chain. A technical candidate is only ever simulated, so it is given the
 * weaker floor that still protects the flash principal.
 */
export function minimumWithdrawFloorRaw(candidate: BuildableCandidate): bigint {
  return candidate.status === "eligible"
    ? candidate.economics.minimumWithdrawRaw
    : candidate.economics.flashRepaymentRaw;
}

export type FlashRedeemPlan = {
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  strategyId: string;
  /** Only economic candidates may be submitted to the network. */
  economicGatePassed: boolean;
  flashBorrowInstructionIndex: number;
  flashBorrowRaw: bigint;
  flashFeeRaw: bigint;
  flashRepaymentRaw: bigint;
  quoteOutRaw: bigint;
  quoteMinimumOutRaw: bigint;
  lstToBurnRaw: bigint;
  lstDecimals: number;
  expectedWithdrawRaw: bigint;
  /** On-chain `WithdrawSol` floor; undefined when the legacy instruction is used. */
  withdrawMinimumLamportsOutRaw?: bigint;
  expectedNetBeforeNetworkRaw: bigint;
  expectedNetAfterBudgetRaw: bigint;
  targetMinimumWithdrawRaw: bigint;
  instructions: TransactionInstruction[];
  routeLabels: string[];
  reserve: string;
  stakePool: string;
  wallet: string;
  wsolAta: string;
  lstAta: string;
  lstMint: string;
};

export type TokenAccountBalanceSnapshot = {
  address: string;
  exists: boolean;
  amountRaw: bigint;
  accountLamportsRaw: bigint;
};

export type ExecutionBalanceSnapshot = {
  capturedAt: string;
  wallet: string;
  walletSolRaw: bigint;
  wsol: TokenAccountBalanceSnapshot;
  lst: TokenAccountBalanceSnapshot;
};

/**
 * Post-finality balance reconciliation. The lambda for a successful redemption
 * is:
 *
 *   walletSolDelta = withdrawLamports - flashRepayment - txFee - newAtaRent
 *
 * so the realized `WithdrawSol` proceeds can be recovered exactly from the
 * before/after snapshots and the finalized fee. Comparing it with the plan's
 * dynamic gate is what catches a trade that landed but did not pay.
 *
 * It is only meaningful for a transaction that actually executed; a reverted
 * transaction changed no balances, so callers must check `succeeded` first.
 */
export type ExecutionReconciliation = {
  realizedWithdrawRaw: bigint;
  realizedNetRaw: bigint;
  requiredWithdrawRaw: bigint;
  clearsMinimumWithdraw: boolean;
  shortfallRaw: bigint;
};

export type FinalizedExecutionAudit = {
  signature: string;
  slot: number;
  succeeded: boolean;
  error?: string;
  transactionFeeRaw: bigint;
  computeUnitsConsumed?: number;
  logMessages: string[];
  reconciliation: ExecutionReconciliation;
  plan: {
    strategyId: string;
    lstMint: string;
    lstDecimals: number;
    borrowRaw: bigint;
    flashRepaymentRaw: bigint;
    expectedWithdrawRaw: bigint;
    expectedNetAfterBudgetRaw: bigint;
  };
  before: ExecutionBalanceSnapshot;
  after: ExecutionBalanceSnapshot;
  delta: {
    walletSolRaw: bigint;
    wsolTokenRaw: bigint;
    wsolAccountLamportsRaw: bigint;
    lstTokenRaw: bigint;
    lstAccountLamportsRaw: bigint;
  };
  auditedAt: string;
};

export type FinalizedSubmission = {
  signature: string;
  confirmationError: unknown | null;
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
 * Builds an execution-mode candidate that passed structural validation. The
 * candidate burns Jupiter's slippage-protected LST minimum, so its economic
 * estimate is conservative. Only the caller's selection policy decides whether
 * this is an economic execution plan or a no-send technical simulation.
 */
export async function buildFlashRedeemPlan(args: {
  connection: Connection;
  wallet: Keypair;
  config: BotConfig;
  runtime: ScannerRuntime;
  candidate: BuildableCandidate;
}): Promise<FlashRedeemPlan> {
  const { connection, wallet, config, runtime, candidate } = args;
  const walletAddress = wallet.publicKey;
  const { pool, strategy } = candidate;

  assert(
    strategy.mode === "execution",
    `Refusing to build scan-only LST strategy ${strategy.id}`,
  );
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
    destinationTokenAccount: lstAta,
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
      withSlippage: config.stakePoolWithdrawSlippage,
      minimumLamportsOutRaw: minimumWithdrawFloorRaw(candidate),
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
    economicGatePassed: candidate.status === "eligible",
    flashBorrowInstructionIndex,
    flashBorrowRaw: candidate.borrowRaw,
    flashFeeRaw: candidate.economics.flashFeeRaw,
    flashRepaymentRaw: candidate.economics.flashRepaymentRaw,
    quoteOutRaw: candidate.quoteOutRaw,
    quoteMinimumOutRaw: candidate.quoteMinimumOutRaw,
    lstToBurnRaw: candidate.lstToBurnRaw,
    lstDecimals: pool.poolTokenDecimals,
    expectedWithdrawRaw: candidate.expectedWithdrawRaw,
    withdrawMinimumLamportsOutRaw: config.stakePoolWithdrawSlippage
      ? minimumWithdrawFloorRaw(candidate)
      : undefined,
    expectedNetBeforeNetworkRaw:
      candidate.economics.expectedNetBeforeNetworkRaw,
    expectedNetAfterBudgetRaw: candidate.economics.expectedNetAfterBudgetRaw,
    targetMinimumWithdrawRaw: candidate.economics.minimumWithdrawRaw,
    instructions,
    routeLabels: swap.routeLabels,
    reserve: runtime.reserve.address.toBase58(),
    stakePool: pool.address.toBase58(),
    wallet: walletAddress.toBase58(),
    wsolAta: wsolAta.toBase58(),
    lstAta: lstAta.toBase58(),
    lstMint: strategy.lstMint.toBase58(),
  };
}

/**
 * Simulates the exact locally signed bytes. It does not replace the blockhash
 * and verifies the signature, so a success is stronger than an RPC preflight
 * that mutates either of those inputs. This is an RPC read-only operation.
 */
export async function simulatePlan(
  connection: Connection,
  plan: FlashRedeemPlan,
): Promise<{ unitsConsumed?: number; logs: string[] }> {
  const simulation = await connection.simulateTransaction(plan.transaction, {
    sigVerify: true,
    replaceRecentBlockhash: false,
    commitment: "processed",
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs ?? [];
    const detail = `${JSON.stringify(simulation.value.err)}\n${logs.join("\n")}`;
    // A wrong instruction variant fails safely here, before any broadcast, so
    // point the operator at the one setting that changes the variant.
    const hint =
      plan.withdrawMinimumLamportsOutRaw !== undefined &&
      detail.includes("InvalidInstructionData")
        ? "\nThe deployed SPL Stake Pool program rejected the protected WithdrawSol variant. " +
          "Verify it on a cluster, then set STAKE_POOL_WITHDRAW_SLIPPAGE=false to fall back " +
          "to the legacy instruction (which gives up the on-chain withdraw floor)."
        : "";
    throw new Error(`Simulation failed: ${detail}${hint}`);
  }
  return {
    unitsConsumed: simulation.value.unitsConsumed,
    logs: simulation.value.logs ?? [],
  };
}

async function snapshotTokenAccount(args: {
  connection: Connection;
  address: PublicKey;
  commitment: Commitment;
}): Promise<TokenAccountBalanceSnapshot> {
  const { connection, address, commitment } = args;
  const account = await connection.getAccountInfo(address, commitment);
  if (!account) {
    return {
      address: address.toBase58(),
      exists: false,
      amountRaw: 0n,
      accountLamportsRaw: 0n,
    };
  }
  const balance = await connection.getTokenAccountBalance(address, commitment);
  return {
    address: address.toBase58(),
    exists: true,
    amountRaw: BigInt(balance.value.amount),
    accountLamportsRaw: BigInt(account.lamports),
  };
}

/**
 * Captures the public balances relevant to the exact redemption plan. It only
 * reads RPC state and is used both immediately before a send and after finality.
 */
export async function captureExecutionBalanceSnapshot(args: {
  connection: Connection;
  plan: FlashRedeemPlan;
  commitment: Commitment;
}): Promise<ExecutionBalanceSnapshot> {
  const { connection, plan, commitment } = args;
  const wallet = new PublicKey(plan.wallet);
  const wsolAta = new PublicKey(plan.wsolAta);
  const lstAta = new PublicKey(plan.lstAta);
  const [walletSol, wsol, lst] = await Promise.all([
    connection.getBalance(wallet, commitment),
    snapshotTokenAccount({ connection, address: wsolAta, commitment }),
    snapshotTokenAccount({ connection, address: lstAta, commitment }),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    wallet: wallet.toBase58(),
    walletSolRaw: BigInt(walletSol),
    wsol,
    lst,
  };
}

/**
 * Sends a previously exact-simulated plan then waits for finality. The caller
 * must audit the returned signature before reporting the execution as success.
 */
export async function sendPlan(
  connection: Connection,
  plan: FlashRedeemPlan,
): Promise<FinalizedSubmission> {
  assert(
    plan.economicGatePassed,
    "Refusing to send a technical-simulation plan that does not clear the economic gate",
  );
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
    "finalized",
  );
  return { signature, confirmationError: confirmation.value.err };
}

/**
 * Recovers the realized `WithdrawSol` proceeds from public balances. Any ATA
 * that did not exist before the send was created inside the transaction, so its
 * rent-exempt lamports are part of the spend and are added back.
 */
export function reconcileExecutionBalances(args: {
  plan: FlashRedeemPlan;
  before: ExecutionBalanceSnapshot;
  after: ExecutionBalanceSnapshot;
  transactionFeeRaw: bigint;
}): ExecutionReconciliation {
  const { plan, before, after, transactionFeeRaw } = args;
  const newAtaRentLamportsRaw =
    (before.wsol.exists ? 0n : after.wsol.accountLamportsRaw) +
    (before.lst.exists ? 0n : after.lst.accountLamportsRaw);
  const realizedWithdrawRaw =
    after.walletSolRaw -
    before.walletSolRaw +
    plan.flashRepaymentRaw +
    transactionFeeRaw +
    newAtaRentLamportsRaw;
  const realizedNetRaw =
    realizedWithdrawRaw -
    plan.flashRepaymentRaw -
    transactionFeeRaw -
    newAtaRentLamportsRaw;
  const requiredWithdrawRaw = plan.targetMinimumWithdrawRaw;
  const clearsMinimumWithdraw = realizedWithdrawRaw >= requiredWithdrawRaw;
  return {
    realizedWithdrawRaw,
    realizedNetRaw,
    requiredWithdrawRaw,
    clearsMinimumWithdraw,
    shortfallRaw: clearsMinimumWithdraw
      ? 0n
      : requiredWithdrawRaw - realizedWithdrawRaw,
  };
}

/**
 * Reads the finalized receipt plus the same public balances captured before the
 * send. `succeeded` is only true when both the final confirmation and finalized
 * transaction metadata report no error.
 */
export async function auditFinalizedExecution(args: {
  connection: Connection;
  plan: FlashRedeemPlan;
  submission: FinalizedSubmission;
  before: ExecutionBalanceSnapshot;
}): Promise<FinalizedExecutionAudit> {
  const { connection, plan, submission, before } = args;
  let receipt = await connection.getTransaction(submission.signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  // A confirming RPC can expose finality just before its transaction-history
  // index answers getTransaction. Retry the read without ever rebroadcasting.
  for (let attempt = 0; !receipt?.meta && attempt < 3; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    receipt = await connection.getTransaction(submission.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
  }
  if (!receipt?.meta) {
    throw new Error(
      `Finalized transaction receipt was not found for ${submission.signature}`,
    );
  }
  const after = await captureExecutionBalanceSnapshot({
    connection,
    plan,
    commitment: "finalized",
  });
  const error = receipt.meta.err ?? submission.confirmationError;
  const succeeded =
    receipt.meta.err === null && submission.confirmationError === null;
  const reconciliation = reconcileExecutionBalances({
    plan,
    before,
    after,
    transactionFeeRaw: BigInt(receipt.meta.fee),
  });
  return {
    signature: submission.signature,
    slot: receipt.slot,
    succeeded,
    error: succeeded ? undefined : JSON.stringify(error),
    transactionFeeRaw: BigInt(receipt.meta.fee),
    computeUnitsConsumed: receipt.meta.computeUnitsConsumed ?? undefined,
    logMessages: receipt.meta.logMessages ?? [],
    reconciliation,
    plan: {
      strategyId: plan.strategyId,
      lstMint: plan.lstMint,
      lstDecimals: plan.lstDecimals,
      borrowRaw: plan.flashBorrowRaw,
      flashRepaymentRaw: plan.flashRepaymentRaw,
      expectedWithdrawRaw: plan.expectedWithdrawRaw,
      expectedNetAfterBudgetRaw: plan.expectedNetAfterBudgetRaw,
    },
    before,
    after,
    delta: {
      walletSolRaw: after.walletSolRaw - before.walletSolRaw,
      wsolTokenRaw: after.wsol.amountRaw - before.wsol.amountRaw,
      wsolAccountLamportsRaw:
        after.wsol.accountLamportsRaw - before.wsol.accountLamportsRaw,
      lstTokenRaw: after.lst.amountRaw - before.lst.amountRaw,
      lstAccountLamportsRaw:
        after.lst.accountLamportsRaw - before.lst.accountLamportsRaw,
    },
    auditedAt: new Date().toISOString(),
  };
}

export function planSummary(
  plan: FlashRedeemPlan,
): Record<string, string | number | string[]> {
  return {
    Strategy: plan.strategyId,
    "Economic gate": plan.economicGatePassed
      ? "PASS"
      : "TECHNICAL SIMULATION ONLY",
    "Kamino WSOL reserve": plan.reserve,
    "LST stake pool": plan.stakePool,
    "Flash borrow": `${formatAtomic(plan.flashBorrowRaw, SOL_DECIMALS)} WSOL`,
    "Kamino flash fee (on-chain)": `${formatAtomic(plan.flashFeeRaw, SOL_DECIMALS)} WSOL`,
    "Flash repayment": `${formatAtomic(plan.flashRepaymentRaw, SOL_DECIMALS)} WSOL`,
    "Jupiter quote output": `${formatAtomic(plan.quoteOutRaw, plan.lstDecimals)} LST`,
    "Jupiter protected output": `${formatAtomic(plan.quoteMinimumOutRaw, plan.lstDecimals)} LST`,
    "LST burned": `${formatAtomic(plan.lstToBurnRaw, plan.lstDecimals)} LST`,
    "WithdrawSol expected": `${formatAtomic(plan.expectedWithdrawRaw, SOL_DECIMALS)} SOL`,
    "WithdrawSol on-chain floor":
      plan.withdrawMinimumLamportsOutRaw === undefined
        ? "none (legacy instruction)"
        : `${formatAtomic(plan.withdrawMinimumLamportsOutRaw, SOL_DECIMALS)} SOL`,
    "Dynamic repayment/profit gate": `${formatAtomic(plan.targetMinimumWithdrawRaw, SOL_DECIMALS)} SOL`,
    "Expected net before network": `${formatAtomic(plan.expectedNetBeforeNetworkRaw, SOL_DECIMALS)} SOL`,
    "Expected net after fee budget": `${formatAtomic(plan.expectedNetAfterBudgetRaw, SOL_DECIMALS)} SOL`,
    "Kamino borrow instruction index": plan.flashBorrowInstructionIndex,
    "Jupiter route": plan.routeLabels,
    "Instruction count": plan.instructions.length,
  };
}
