import BN from "bn.js";
import {
  STAKE_POOL_PROGRAM_ID,
  StakePoolInstruction,
  getStakePoolAccount,
  type StakePool,
} from "@solana/spl-stake-pool";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { ceilDiv } from "./amount.js";

export type LoadedStakePool = {
  address: PublicKey;
  state: StakePool;
  withdrawAuthority: PublicKey;
  reserveLamports: bigint;
  currentEpoch: bigint;
  poolTokenDecimals: number;
};

function bnToBigInt(value: BN): bigint {
  return BigInt(value.toString(10));
}

/** Load and verify the account is the canonical SPL stake-pool deployment. */
export async function loadStakePool(
  connection: Connection,
  address: PublicKey,
): Promise<LoadedStakePool> {
  const raw = await getStakePoolAccount(connection, address);
  if (!raw || !raw.account)
    throw new Error(`Stake pool ${address.toBase58()} does not exist`);
  if (!raw.account.owner.equals(STAKE_POOL_PROGRAM_ID)) {
    throw new Error(
      `Stake pool ${address.toBase58()} is not owned by the SPL Stake Pool program`,
    );
  }

  const state = raw.account.data as StakePool;
  const [withdrawAuthority] = PublicKey.findProgramAddressSync(
    [address.toBuffer(), Buffer.from("withdraw")],
    STAKE_POOL_PROGRAM_ID,
  );
  const [reserveBalance, epochInfo, poolMintAccount] = await Promise.all([
    connection.getBalance(state.reserveStake, "processed"),
    connection.getEpochInfo("processed"),
    connection.getAccountInfo(state.poolMint, "processed"),
  ]);
  if (
    !poolMintAccount ||
    !poolMintAccount.owner.equals(state.tokenProgramId) ||
    poolMintAccount.data.length < 45
  ) {
    throw new Error(
      `Stake pool ${address.toBase58()} has an invalid pool-token mint account`,
    );
  }
  // SPL Mint layout stores `decimals` at offset 44. Legacy Token and Token-2022
  // share this base Mint layout, while the owner check above binds it to the pool.
  const poolTokenDecimals = poolMintAccount.data[44];
  if (poolTokenDecimals === undefined)
    throw new Error("Could not read stake-pool token decimals");

  return {
    address,
    state,
    withdrawAuthority,
    reserveLamports: BigInt(reserveBalance),
    currentEpoch: BigInt(epochInfo.epoch),
    poolTokenDecimals,
  };
}

/**
 * Conservative preview of WithdrawSol proceeds. The pool program applies the
 * pool-token exchange ratio then the configured SOL-withdrawal fee. Rounding the
 * fee upward ensures this preview never overstates the receive amount.
 */
export function estimateWithdrawSolLamports(
  state: StakePool,
  poolTokens: bigint,
): bigint {
  const totalLamports = bnToBigInt(state.totalLamports);
  const poolTokenSupply = bnToBigInt(state.poolTokenSupply);
  if (poolTokenSupply === 0n)
    throw new Error("Stake-pool token supply is zero");

  const grossLamports = (poolTokens * totalLamports) / poolTokenSupply;
  const numerator = bnToBigInt(state.solWithdrawalFee.numerator);
  const denominator = bnToBigInt(state.solWithdrawalFee.denominator);
  if (denominator === 0n || numerator === 0n) return grossLamports;

  const fee = ceilDiv(grossLamports * numerator, denominator);
  if (fee >= grossLamports)
    throw new Error(
      "Stake-pool SOL withdrawal fee consumes the entire withdrawal",
    );
  return grossLamports - fee;
}

export function buildUpdateStakePoolBalanceInstruction(
  pool: LoadedStakePool,
): TransactionInstruction {
  return StakePoolInstruction.updateStakePoolBalance({
    stakePool: pool.address,
    withdrawAuthority: pool.withdrawAuthority,
    validatorList: pool.state.validatorList,
    reserveStake: pool.state.reserveStake,
    managerFeeAccount: pool.state.managerFeeAccount,
    poolMint: pool.state.poolMint,
  });
}

/** Reject pools that require an authority the scanner wallet does not control. */
export function assertSolWithdrawPermission(
  pool: LoadedStakePool,
  wallet: PublicKey,
): void {
  if (
    pool.state.solWithdrawAuthority &&
    !pool.state.solWithdrawAuthority.equals(wallet)
  ) {
    throw new Error(
      `Pool requires SOL withdrawal authority ${pool.state.solWithdrawAuthority.toBase58()}; this bot only supports a wallet-owned, permissionless pool`,
    );
  }
}

/**
 * Burns the exact LST input and withdraws immediately-liquid SOL from the
 * reserve. This uses the wallet as the token authority, avoiding a temporary
 * approve delegate or an extra signer in the atomic transaction.
 */
export function buildWithdrawSolInstruction(args: {
  pool: LoadedStakePool;
  wallet: PublicKey;
  sourceLstAccount: PublicKey;
  poolTokens: bigint;
}): TransactionInstruction {
  const { pool, wallet, sourceLstAccount, poolTokens } = args;
  assertSolWithdrawPermission(pool, wallet);

  if (poolTokens > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "LST withdrawal amount exceeds the stake-pool SDK safe-integer limit",
    );
  }

  return StakePoolInstruction.withdrawSol({
    stakePool: pool.address,
    withdrawAuthority: pool.withdrawAuthority,
    sourceTransferAuthority: wallet,
    sourcePoolAccount: sourceLstAccount,
    reserveStake: pool.state.reserveStake,
    destinationSystemAccount: wallet,
    managerFeeAccount: pool.state.managerFeeAccount,
    poolMint: pool.state.poolMint,
    poolTokens: Number(poolTokens),
    solWithdrawAuthority: pool.state.solWithdrawAuthority,
  });
}

/** Freshness check for UpdateStakePoolBalance; validator balances must be cranked first. */
export function assertStakePoolEpochFresh(pool: LoadedStakePool): void {
  const lastUpdateEpoch = bnToBigInt(pool.state.lastUpdateEpoch);
  if (lastUpdateEpoch !== pool.currentEpoch) {
    throw new Error(
      `Stake pool validator list is stale (last update epoch ${lastUpdateEpoch}, current ${pool.currentEpoch}). ` +
        "Run the permissionless validator-list crank in a separate transaction, then retry the atomic bot.",
    );
  }
}
