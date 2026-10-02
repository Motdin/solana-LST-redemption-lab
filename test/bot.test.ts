import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  auditFinalizedExecution,
  buildFlashRedeemPlan,
  sendPlan,
  simulatePlan,
  type FlashRedeemPlan,
} from "../src/bot.js";
import type { EligibleCandidate } from "../src/scanner.js";

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
