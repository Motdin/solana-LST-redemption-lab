import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExecutionBalanceSnapshot,
  FinalizedExecutionAudit,
} from "./bot.js";

export type ExecutionAuditLogPath = {
  jsonlPath: string;
};

/**
 * A receipt for an execution whose end-to-end audit could not be completed
 * (RPC failure after a broadcast, timeout, lost connection). It exists so a
 * broadcast signature is never lost just because the follow-up reads failed.
 */
export type PartialExecutionAudit = {
  signature?: string;
  capturedAt: string;
  error: string;
  plan: {
    strategyId: string;
    lstMint: string;
    borrowRaw: bigint;
    flashRepaymentRaw: bigint;
    expectedWithdrawRaw: bigint;
    targetMinimumWithdrawRaw: bigint;
  };
  before?: ExecutionBalanceSnapshot;
};

function snapshotRecord(snapshot: ExecutionBalanceSnapshot) {
  return {
    capturedAt: snapshot.capturedAt,
    wallet: snapshot.wallet,
    walletSolRaw: snapshot.walletSolRaw.toString(),
    wsol: {
      address: snapshot.wsol.address,
      exists: snapshot.wsol.exists,
      amountRaw: snapshot.wsol.amountRaw.toString(),
      accountLamportsRaw: snapshot.wsol.accountLamportsRaw.toString(),
    },
    lst: {
      address: snapshot.lst.address,
      exists: snapshot.lst.exists,
      amountRaw: snapshot.lst.amountRaw.toString(),
      accountLamportsRaw: snapshot.lst.accountLamportsRaw.toString(),
    },
  };
}

/** Converts the public finalized receipt into a JSON-safe local audit record. */
export function executionAuditRecord(audit: FinalizedExecutionAudit) {
  return {
    schemaVersion: 1,
    partial: false,
    auditedAt: audit.auditedAt,
    signature: audit.signature,
    slot: audit.slot,
    succeeded: audit.succeeded,
    error: audit.error ?? null,
    transactionFeeRaw: audit.transactionFeeRaw.toString(),
    computeUnitsConsumed: audit.computeUnitsConsumed ?? null,
    reconciliation: {
      realizedWithdrawRaw: audit.reconciliation.realizedWithdrawRaw.toString(),
      realizedNetRaw: audit.reconciliation.realizedNetRaw.toString(),
      requiredWithdrawRaw: audit.reconciliation.requiredWithdrawRaw.toString(),
      clearsMinimumWithdraw: audit.reconciliation.clearsMinimumWithdraw,
      shortfallRaw: audit.reconciliation.shortfallRaw.toString(),
    },
    plan: {
      strategyId: audit.plan.strategyId,
      lstMint: audit.plan.lstMint,
      lstDecimals: audit.plan.lstDecimals,
      borrowRaw: audit.plan.borrowRaw.toString(),
      flashRepaymentRaw: audit.plan.flashRepaymentRaw.toString(),
      expectedWithdrawRaw: audit.plan.expectedWithdrawRaw.toString(),
      expectedNetAfterBudgetRaw:
        audit.plan.expectedNetAfterBudgetRaw.toString(),
    },
    before: snapshotRecord(audit.before),
    after: snapshotRecord(audit.after),
    delta: {
      walletSolRaw: audit.delta.walletSolRaw.toString(),
      wsolTokenRaw: audit.delta.wsolTokenRaw.toString(),
      wsolAccountLamportsRaw: audit.delta.wsolAccountLamportsRaw.toString(),
      lstTokenRaw: audit.delta.lstTokenRaw.toString(),
      lstAccountLamportsRaw: audit.delta.lstAccountLamportsRaw.toString(),
    },
    logMessages: audit.logMessages,
  };
}

/** JSON-safe record for an execution that could not be fully audited. */
export function partialExecutionAuditRecord(audit: PartialExecutionAudit) {
  return {
    schemaVersion: 1,
    partial: true,
    auditedAt: new Date().toISOString(),
    capturedAt: audit.capturedAt,
    signature: audit.signature ?? null,
    error: audit.error,
    plan: {
      strategyId: audit.plan.strategyId,
      lstMint: audit.plan.lstMint,
      borrowRaw: audit.plan.borrowRaw.toString(),
      flashRepaymentRaw: audit.plan.flashRepaymentRaw.toString(),
      expectedWithdrawRaw: audit.plan.expectedWithdrawRaw.toString(),
      targetMinimumWithdrawRaw: audit.plan.targetMinimumWithdrawRaw.toString(),
    },
    before: audit.before ? snapshotRecord(audit.before) : null,
  };
}

async function appendRecord(
  directory: string,
  record: unknown,
): Promise<ExecutionAuditLogPath> {
  const resolvedDirectory = resolve(directory);
  const suffix = new Date().toISOString().slice(0, 10);
  const jsonlPath = `${resolvedDirectory}/lst-execution-audits-${suffix}.jsonl`;
  await mkdir(resolvedDirectory, { recursive: true });
  await appendFile(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
  return { jsonlPath };
}

/**
 * Appends a finalized execution receipt locally. It stores public addresses,
 * balances, and program logs, but never keypair material or transaction bytes.
 */
export async function appendExecutionAuditLog(args: {
  directory: string;
  audit: FinalizedExecutionAudit;
}): Promise<ExecutionAuditLogPath> {
  return appendRecord(args.directory, executionAuditRecord(args.audit));
}

/**
 * Appends a partial receipt. Callers use this in a `catch` path after a send, so
 * the signature and the pre-send snapshot survive even when the audit reads do
 * not. It must never throw away the original failure.
 */
export async function appendPartialExecutionAuditLog(args: {
  directory: string;
  audit: PartialExecutionAudit;
}): Promise<ExecutionAuditLogPath> {
  return appendRecord(args.directory, partialExecutionAuditRecord(args.audit));
}
