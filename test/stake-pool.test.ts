import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { StakePoolInstruction, type StakePool } from "@solana/spl-stake-pool";
import { Keypair } from "@solana/web3.js";
import {
  buildWithdrawSolInstruction,
  estimateWithdrawSolLamports,
  WITHDRAW_SOL_WITH_SLIPPAGE_INDEX,
  type LoadedStakePool,
} from "../src/stake-pool.js";

function poolWithFee(
  numerator: number,
  denominator: number,
  nextFee?: { numerator: number; denominator: number },
): StakePool {
  // Only these fields are read by the estimator; use a narrow fixture rather
  // than an RPC fixture so rounding behavior stays unit-testable.
  return {
    totalLamports: new BN("3311900000"),
    poolTokenSupply: new BN("1113300000"),
    solWithdrawalFee: {
      numerator: new BN(numerator),
      denominator: new BN(denominator),
    },
    nextSolWithdrawalFee: nextFee
      ? {
          numerator: new BN(nextFee.numerator),
          denominator: new BN(nextFee.denominator),
        }
      : undefined,
  } as StakePool;
}

function loadedPool(): LoadedStakePool {
  const pool = poolWithFee(0, 1);
  return {
    address: Keypair.generate().publicKey,
    state: {
      ...pool,
      reserveStake: Keypair.generate().publicKey,
      managerFeeAccount: Keypair.generate().publicKey,
      poolMint: Keypair.generate().publicKey,
      solWithdrawAuthority: undefined,
    } as StakePool,
    withdrawAuthority: Keypair.generate().publicKey,
    reserveLamports: 1_000_000_000_000n,
    currentEpoch: 900n,
    poolTokenDecimals: 9,
  };
}

describe("stake-pool instant-withdraw preview", () => {
  it("returns the requested 3.3119 SOL before withdrawal fee", () => {
    expect(estimateWithdrawSolLamports(poolWithFee(0, 1), 1_113_300_000n)).toBe(
      3_311_900_000n,
    );
  });

  it("rounds the fee upward, never overstating proceeds", () => {
    expect(
      estimateWithdrawSolLamports(poolWithFee(1, 1_000), 1_113_300_000n),
    ).toBe(3_308_588_100n);
  });

  it("charges the higher of the current and scheduled withdrawal fees", () => {
    expect(
      estimateWithdrawSolLamports(
        poolWithFee(0, 1, { numerator: 1, denominator: 100 }),
        1_113_300_000n,
      ),
    ).toBe(3_278_781_000n);
    expect(
      estimateWithdrawSolLamports(
        poolWithFee(1, 100, { numerator: 1, denominator: 1_000 }),
        1_113_300_000n,
      ),
    ).toBe(3_278_781_000n);
  });
});

describe("protected WithdrawSol instruction", () => {
  it("encodes WithdrawSolWithSlippage with the declared on-chain floor", () => {
    const pool = loadedPool();
    const wallet = Keypair.generate().publicKey;
    const lstAccount = Keypair.generate().publicKey;
    const instruction = buildWithdrawSolInstruction({
      pool,
      wallet,
      sourceLstAccount: lstAccount,
      poolTokens: 1_090_000_000n,
      withSlippage: true,
      minimumLamportsOutRaw: 1_005_100_000n,
    });

    expect(instruction.data.length).toBe(17);
    expect(instruction.data[0]).toBe(WITHDRAW_SOL_WITH_SLIPPAGE_INDEX);
    expect(instruction.data.readBigUInt64LE(1)).toBe(1_090_000_000n);
    expect(instruction.data.readBigUInt64LE(9)).toBe(1_005_100_000n);
    // The account list must stay identical to the legacy variant.
    expect(instruction.keys.map((key) => key.pubkey.toBase58())).toEqual(
      StakePoolInstruction.withdrawSol({
        stakePool: pool.address,
        withdrawAuthority: pool.withdrawAuthority,
        sourceTransferAuthority: wallet,
        sourcePoolAccount: lstAccount,
        reserveStake: pool.state.reserveStake,
        destinationSystemAccount: wallet,
        managerFeeAccount: pool.state.managerFeeAccount,
        poolMint: pool.state.poolMint,
        poolTokens: 1_090_000_000,
      }).keys.map((key) => key.pubkey.toBase58()),
    );
  });

  it("keeps the legacy instruction when slippage protection is disabled", () => {
    const instruction = buildWithdrawSolInstruction({
      pool: loadedPool(),
      wallet: Keypair.generate().publicKey,
      sourceLstAccount: Keypair.generate().publicKey,
      poolTokens: 1_090_000_000n,
      withSlippage: false,
    });

    expect(instruction.data.length).toBe(9);
    expect(instruction.data[0]).toBe(16);
  });

  it("refuses a protected withdrawal without a positive floor", () => {
    const pool = loadedPool();
    const wallet = Keypair.generate().publicKey;
    const sourceLstAccount = Keypair.generate().publicKey;
    const base = {
      pool,
      wallet,
      sourceLstAccount,
      poolTokens: 1n,
      withSlippage: true,
    };

    expect(() => buildWithdrawSolInstruction(base)).toThrow(
      "requires a positive minimum-lamports-out floor",
    );
    expect(() =>
      buildWithdrawSolInstruction({ ...base, minimumLamportsOutRaw: 0n }),
    ).toThrow("requires a positive minimum-lamports-out floor");
  });
});
