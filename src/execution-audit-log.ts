import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExecutionBalanceSnapshot,
  FinalizedExecutionAudit,
} from "./bot.js";

export type ExecutionAuditLogPath = {
  jsonlPath: string;
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
    auditedAt: audit.auditedAt,
    signature: audit.signature,
    slot: audit.slot,
    succeeded: audit.succeeded,
    error: audit.error ?? null,
    transactionFeeRaw: audit.transactionFeeRaw.toString(),
    computeUnitsConsumed: audit.computeUnitsConsumed ?? null,
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

/**
 * Appends a finalized execution receipt locally. It stores public addresses,
 * balances, and program logs, but never keypair material or transaction bytes.
 */
export async function appendExecutionAuditLog(args: {
  directory: string;
  audit: FinalizedExecutionAudit;
}): Promise<ExecutionAuditLogPath> {
  const resolvedDirectory = resolve(args.directory);
  const suffix = args.audit.auditedAt.slice(0, 10);
  const jsonlPath = `${resolvedDirectory}/lst-execution-audits-${suffix}.jsonl`;
  await mkdir(resolvedDirectory, { recursive: true });
  await appendFile(
    jsonlPath,
    `${JSON.stringify(executionAuditRecord(args.audit))}\n`,
    "utf8",
  );
  return { jsonlPath };
}
