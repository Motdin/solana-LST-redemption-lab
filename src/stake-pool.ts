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

/**
 * Borsh variant index of `StakePoolInstruction::WithdrawSolWithSlippage` in the
 * SPL Stake Pool program. Variants are appended in declaration order, and this
 * variant was appended in February 2023 (solana-program/stake-pool #3980,
 * "Add slippage to all deposit and withdraw ixs"), so it precedes nothing that
 * predates it in the layout.
 *
 * The data payload is `borsh(u64 pool_tokens_in, u64 minimum_lamports_out)`.
 * Because the repository always simulates the exact signed transaction before
 * it can be broadcast, an unsupported index fails safely in simulation and
 * never reaches the network; `STAKE_POOL_WITHDRAW_SLIPPAGE=false` falls back to
 * the legacy instruction if the pinned program ever lacks it.
 */
export const WITHDRAW_SOL_WITH_SLIPPAGE_INDEX = 26;
const WITHDRAW_SOL_WITH_SLIPPAGE_DATA_LENGTH = 17;
const U64_MAX = (1n << 64n) - 1n;

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
 *
 * When a pool has already scheduled a `nextSolWithdrawalFee`, the larger of the
 * two is used. The scanner separately rejects a stale pool, which is the only
 * situation in which the program promotes the pending fee, so this is pure
 * defensiveness against a rule change rather than an expected path.
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
  const fee = effectiveSolWithdrawalFee(state);
  if (!fee) return grossLamports;

  const charged = ceilDiv(grossLamports * fee.numerator, fee.denominator);
  if (charged >= grossLamports)
    throw new Error(
      "Stake-pool SOL withdrawal fee consumes the entire withdrawal",
    );
  return grossLamports - charged;
}

type WithdrawalFee = { numerator: bigint; denominator: bigint };

/** The more expensive of the active and the scheduled SOL-withdrawal fee. */
function effectiveSolWithdrawalFee(
  state: StakePool,
): WithdrawalFee | undefined {
  const candidates: WithdrawalFee[] = [];
  const current = asWithdrawalFee(state.solWithdrawalFee);
  if (current) candidates.push(current);
  const next = state.nextSolWithdrawalFee
    ? asWithdrawalFee(state.nextSolWithdrawalFee)
    : undefined;
  if (next) candidates.push(next);

  let highest: WithdrawalFee | undefined;
  for (const candidate of candidates) {
    if (
      !highest ||
      candidate.numerator * highest.denominator >
        highest.numerator * candidate.denominator
    ) {
      highest = candidate;
    }
  }
  return highest;
}

function asWithdrawalFee(value: {
  numerator: BN;
  denominator: BN;
}): WithdrawalFee | undefined {
  const numerator = bnToBigInt(value.numerator);
  const denominator = bnToBigInt(value.denominator);
  if (numerator === 0n || denominator === 0n) return undefined;
  return { numerator, denominator };
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
 *
 * When `withSlippage` is set, the program enforces `minimumLamportsOutRaw`
 * on-chain. That floor is what stops a redemption shortfall from being papered
 * over by the wallet's own SOL during the repayment step: without it, a small
 * withdrawal simply gets topped up and the loss lands silently.
 */
export function buildWithdrawSolInstruction(args: {
  pool: LoadedStakePool;
  wallet: PublicKey;
  sourceLstAccount: PublicKey;
  poolTokens: bigint;
  withSlippage: boolean;
  minimumLamportsOutRaw?: bigint;
}): TransactionInstruction {
  const { pool, wallet, sourceLstAccount, poolTokens, withSlippage } = args;
  assertSolWithdrawPermission(pool, wallet);

  if (poolTokens > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "LST withdrawal amount exceeds the stake-pool SDK safe-integer limit",
    );
  }

  const classicInstruction = StakePoolInstruction.withdrawSol({
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
  if (!withSlippage) return classicInstruction;

  const minimumLamportsOutRaw = args.minimumLamportsOutRaw;
  if (minimumLamportsOutRaw === undefined || minimumLamportsOutRaw <= 0n) {
    throw new Error(
      "A protected WithdrawSol requires a positive minimum-lamports-out floor",
    );
  }
  if (poolTokens > U64_MAX || minimumLamportsOutRaw > U64_MAX) {
    throw new Error(
      "WithdrawSol amounts must fit in an unsigned 64-bit integer",
    );
  }

  // Account order is identical between the two variants; reuse the SDK's list
  // so the layout can only diverge in the instruction data.
  const data = Buffer.alloc(WITHDRAW_SOL_WITH_SLIPPAGE_DATA_LENGTH);
  data.writeUInt8(WITHDRAW_SOL_WITH_SLIPPAGE_INDEX, 0);
  data.writeBigUInt64LE(poolTokens, 1);
  data.writeBigUInt64LE(minimumLamportsOutRaw, 9);
  return new TransactionInstruction({
    programId: classicInstruction.programId,
    keys: classicInstruction.keys,
    data,
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
