import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

/** Legacy SPL Token program. WSOL uses this program. */
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
/** Token-2022 program. Some LSTs (e.g. Token-2022 pools) debit it via Jupiter. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export function deriveAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Associated Token Program instruction 1 = CreateIdempotent. It can safely be
 * included whether the ATA already exists or not, keeping the flash-borrow
 * instruction index deterministic.
 */
export function createAssociatedTokenAccountIdempotentInstruction(args: {
  payer: PublicKey;
  associatedToken: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  const { payer, associatedToken, owner, mint, tokenProgram } = args;
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** SPL Token instruction 17 = SyncNative. */
export function createSyncNativeInstruction(
  account: PublicKey,
  tokenProgram = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),
  });
}
