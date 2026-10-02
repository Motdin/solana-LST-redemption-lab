import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  auditFinalizedExecution,
  buildFlashRedeemPlan,
  minimumWithdrawFloorRaw,
  reconcileExecutionBalances,
  sendPlan,
  simulatePlan,
  type FlashRedeemPlan,
} from "../src/bot.js";
import type { BuildableCandidate, EligibleCandidate } from "../src/scanner.js";

const scanOnlyCandidate = {
  strategy: {
    id: "research-pool",
    mode: "scan-only",
  },
} as unknown as EligibleCandidate;

function plan(overrides: Partial<FlashRedeemPlan> = {}): FlashRedeemPlan {
  const wallet = Keypair.generate().publicKey;
  return {
    transaction: {} as FlashRedeemPlan["transaction"],
    blockhash: "blockhash",
    lastValidBlockHeight: 42,
    strategyId: "jitosol-redemption",
    economicGatePassed: true,
    flashBorrowInstructionIndex: 4,
    flashBorrowRaw: 1_000_000_000n,
    flashFeeRaw: 100_000n,
    flashRepaymentRaw: 1_000_100_000n,
    quoteOutRaw: 1_100_000_000n,
    quoteMinimumOutRaw: 1_090_000_000n,
    lstToBurnRaw: 1_090_000_000n,
    lstDecimals: 9,
    expectedWithdrawRaw: 1_020_000_000n,
    expectedNetBeforeNetworkRaw: 19_900_000n,
    expectedNetAfterBudgetRaw: 14_900_000n,
    targetMinimumWithdrawRaw: 1_005_100_000n,
    instructions: [],
    routeLabels: [],
    reserve: Keypair.generate().publicKey.toBase58(),
    stakePool: Keypair.generate().publicKey.toBase58(),
    wallet: wallet.toBase58(),
    wsolAta: Keypair.generate().publicKey.toBase58(),
    lstAta: Keypair.generate().publicKey.toBase58(),
    lstMint: Keypair.generate().publicKey.toBase58(),
    ...overrides,
  };
}

describe("flash redemption builder", () => {
  it("rejects a scan-only candidate before requesting Jupiter instructions", async () => {
    await expect(
      buildFlashRedeemPlan({
        connection: null,
        wallet: Keypair.generate(),
        config: null,
        runtime: null,
        candidate: scanOnlyCandidate,
      } as never),
    ).rejects.toThrow("Refusing to build scan-only LST strategy research-pool");
  });

  it("exact-simulates signed bytes without replacing the blockhash", async () => {
    const connection = {
      simulateTransaction: vi.fn().mockResolvedValue({
        value: { err: null, unitsConsumed: 123_456, logs: ["Program log: ok"] },
      }),
    };

    await expect(simulatePlan(connection as never, plan())).resolves.toEqual({
      unitsConsumed: 123_456,
      logs: ["Program log: ok"],
    });
    expect(connection.simulateTransaction).toHaveBeenCalledWith(
      expect.anything(),
      {
        sigVerify: true,
        replaceRecentBlockhash: false,
        commitment: "processed",
      },
    );
  });

  it("refuses to submit a technical-simulation plan", async () => {
    const connection = { sendRawTransaction: vi.fn() };

    await expect(
      sendPlan(connection as never, plan({ economicGatePassed: false })),
    ).rejects.toThrow("Refusing to send a technical-simulation plan");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("waits for finality and audits finalized receipt plus public balances", async () => {
    const transaction = {
      serialize: vi.fn().mockReturnValue(Buffer.from([1, 2, 3])),
    } as unknown as FlashRedeemPlan["transaction"];
    const executionPlan = plan({ transaction });
    const connection = {
      sendRawTransaction: vi.fn().mockResolvedValue("signature"),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getTransaction: vi.fn().mockResolvedValue({
        slot: 999,
        meta: {
          err: null,
          fee: 5_000,
          computeUnitsConsumed: 432_100,
          logMessages: ["Program log: finalized"],
        },
      }),
      getBalance: vi.fn().mockResolvedValue(2_000_000_000),
      getAccountInfo: vi.fn().mockResolvedValue(null),
    };
    const submission = await sendPlan(connection as never, executionPlan);
    const before = {
      capturedAt: "2026-10-02T00:00:00.000Z",
      wallet: executionPlan.wallet,
      walletSolRaw: 1_000_000_000n,
      wsol: {
        address: executionPlan.wsolAta,
        exists: false,
        amountRaw: 0n,
        accountLamportsRaw: 0n,
      },
      lst: {
        address: executionPlan.lstAta,
        exists: false,
        amountRaw: 0n,
        accountLamportsRaw: 0n,
      },
    };
    const audit = await auditFinalizedExecution({
      connection: connection as never,
      plan: executionPlan,
      submission,
      before,
    });

    expect(connection.confirmTransaction).toHaveBeenCalledWith(
      {
        signature: "signature",
        blockhash: "blockhash",
        lastValidBlockHeight: 42,
      },
      "finalized",
    );
    expect(audit).toMatchObject({
      signature: "signature",
      slot: 999,
      succeeded: true,
      transactionFeeRaw: 5_000n,
      delta: { walletSolRaw: 1_000_000_000n },
    });
    expect(audit.logMessages).toEqual(["Program log: finalized"]);
  });
});

describe("minimum withdraw floor", () => {
  it("makes an economic candidate clear the whole gate on chain", () => {
    expect(
      minimumWithdrawFloorRaw({
        status: "eligible",
        economics: {
          minimumWithdrawRaw: 1_005_100_000n,
          flashRepaymentRaw: 1_000_100_000n,
        },
      } as unknown as EligibleCandidate),
    ).toBe(1_005_100_000n);
  });

  it("gives a technical candidate the weaker principal-only floor", () => {
    expect(
      minimumWithdrawFloorRaw({
        status: "technical",
        economics: {
          minimumWithdrawRaw: 1_005_100_000n,
          flashRepaymentRaw: 1_000_100_000n,
        },
      } as unknown as BuildableCandidate),
    ).toBe(1_000_100_000n);
  });
});

describe("post-finality reconciliation", () => {
  const lstAta = Keypair.generate().publicKey.toBase58();

  function snapshot(walletSolRaw: bigint, wsolExists: boolean) {
    return {
      capturedAt: "2026-10-02T00:00:00.000Z",
      wallet: Keypair.generate().publicKey.toBase58(),
      walletSolRaw,
      wsol: {
        address: Keypair.generate().publicKey.toBase58(),
        exists: wsolExists,
        amountRaw: 0n,
        accountLamportsRaw: 2_039_280n,
      },
      lst: {
        address: lstAta,
        exists: true,
        amountRaw: 0n,
        accountLamportsRaw: 2_039_280n,
      },
    };
  }

  it("recovers realized WithdrawSol proceeds from public balances", () => {
    const executionPlan = plan();
    const reconciliation = reconcileExecutionBalances({
      plan: executionPlan,
      before: snapshot(10_000_000_000n, false),
      after: snapshot(10_017_855_720n, true),
      transactionFeeRaw: 5_000n,
    });

    expect(reconciliation.realizedWithdrawRaw).toBe(1_020_000_000n);
    expect(reconciliation.realizedNetRaw).toBe(17_855_720n);
    expect(reconciliation.clearsMinimumWithdraw).toBe(true);
    expect(reconciliation.shortfallRaw).toBe(0n);
  });

  it("flags a landed trade whose wallet SOL silently covered the shortfall", () => {
    // WithdrawSol returned less than the flash repayment. The atomic flow still
    // lands because the wallet tops the WSOL ATA up, so only the realized
    // proceeds reveal the loss.
    const executionPlan = plan();
    // before + 1_000_000_000 withdrawn - 1_000_100_000 repaid - 5_000 fee
    const reconciliation = reconcileExecutionBalances({
      plan: executionPlan,
      before: snapshot(10_000_000_000n, true),
      after: snapshot(9_999_895_000n, true),
      transactionFeeRaw: 5_000n,
    });

    expect(reconciliation.realizedWithdrawRaw).toBe(1_000_000_000n);
    expect(reconciliation.realizedWithdrawRaw).toBeLessThan(
      executionPlan.flashRepaymentRaw,
    );
    expect(reconciliation.clearsMinimumWithdraw).toBe(false);
    expect(reconciliation.shortfallRaw).toBe(5_100_000n);
  });
});
