import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FinalizedExecutionAudit } from "../src/bot.js";
import {
  appendExecutionAuditLog,
  appendPartialExecutionAuditLog,
  executionAuditRecord,
  partialExecutionAuditRecord,
} from "../src/execution-audit-log.js";

function audit(): FinalizedExecutionAudit {
  return {
    signature: "example-signature",
    slot: 123,
    succeeded: true,
    transactionFeeRaw: 5_000n,
    computeUnitsConsumed: 456_789,
    logMessages: ["Program log: success"],
    plan: {
      strategyId: "jitosol-redemption",
      lstMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
      lstDecimals: 9,
      borrowRaw: 1_000_000_000n,
      flashRepaymentRaw: 1_000_100_000n,
      expectedWithdrawRaw: 1_020_000_000n,
      expectedNetAfterBudgetRaw: 14_900_000n,
    },
    before: {
      capturedAt: "2026-10-02T00:00:00.000Z",
      wallet: "wallet",
      walletSolRaw: 100n,
      wsol: {
        address: "wsol-ata",
        exists: false,
        amountRaw: 0n,
        accountLamportsRaw: 0n,
      },
      lst: {
        address: "lst-ata",
        exists: true,
        amountRaw: 5n,
        accountLamportsRaw: 2_039_280n,
      },
    },
    after: {
      capturedAt: "2026-10-02T00:01:00.000Z",
      wallet: "wallet",
      walletSolRaw: 200n,
      wsol: {
        address: "wsol-ata",
        exists: true,
        amountRaw: 0n,
        accountLamportsRaw: 2_039_280n,
      },
      lst: {
        address: "lst-ata",
        exists: true,
        amountRaw: 7n,
        accountLamportsRaw: 2_039_280n,
      },
    },
    delta: {
      walletSolRaw: 100n,
      wsolTokenRaw: 0n,
      wsolAccountLamportsRaw: 2_039_280n,
      lstTokenRaw: 2n,
      lstAccountLamportsRaw: 0n,
    },
    reconciliation: {
      realizedWithdrawRaw: 1_020_000_000n,
      realizedNetRaw: 19_900_000n,
      requiredWithdrawRaw: 1_015_100_000n,
      clearsMinimumWithdraw: true,
      shortfallRaw: 0n,
    },
    auditedAt: "2026-10-02T00:01:00.000Z",
  };
}

describe("execution audit log", () => {
  it("serializes raw bigint balances and never transaction bytes", () => {
    const record = executionAuditRecord(audit());

    expect(record.transactionFeeRaw).toBe("5000");
    expect(record.delta.lstTokenRaw).toBe("2");
    expect(record.partial).toBe(false);
    expect(record.reconciliation).toMatchObject({
      realizedWithdrawRaw: "1020000000",
      clearsMinimumWithdraw: true,
      shortfallRaw: "0",
    });
    expect(JSON.stringify(record)).not.toContain("private");
  });

  it("records a partial receipt so a broadcast signature is never lost", () => {
    const record = partialExecutionAuditRecord({
      signature: "example-signature",
      capturedAt: "2026-10-02T00:00:00.000Z",
      error: "Finalized transaction receipt was not found",
      plan: {
        strategyId: "jitosol-redemption",
        lstMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
        borrowRaw: 1_000_000_000n,
        flashRepaymentRaw: 1_000_100_000n,
        expectedWithdrawRaw: 1_020_000_000n,
        targetMinimumWithdrawRaw: 1_005_100_000n,
      },
    });

    expect(record).toMatchObject({
      partial: true,
      signature: "example-signature",
      before: null,
      plan: { targetMinimumWithdrawRaw: "1005100000" },
    });
  });

  it("appends a finalized receipt as JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ut-execution-audit-"));
    try {
      const { jsonlPath } = await appendExecutionAuditLog({
        directory,
        audit: audit(),
      });
      const record = JSON.parse(await readFile(jsonlPath, "utf8")) as {
        signature: string;
        succeeded: boolean;
      };

      expect(record).toMatchObject({
        signature: "example-signature",
        succeeded: true,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("appends a partial receipt to the same daily JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ut-execution-audit-"));
    try {
      const { jsonlPath } = await appendPartialExecutionAuditLog({
        directory,
        audit: {
          capturedAt: "2026-10-02T00:00:00.000Z",
          error: "RPC read failed after broadcast",
          plan: {
            strategyId: "bsol-redemption",
            lstMint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
            borrowRaw: 500_000_000n,
            flashRepaymentRaw: 500_050_000n,
            expectedWithdrawRaw: 510_000_000n,
            targetMinimumWithdrawRaw: 505_050_000n,
          },
        },
      });
      const record = JSON.parse(await readFile(jsonlPath, "utf8")) as {
        partial: boolean;
        signature: string | null;
        error: string;
      };

      expect(record).toMatchObject({
        partial: true,
        signature: null,
        error: "RPC read failed after broadcast",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
