import "dotenv/config";
import { KaminoMarket, PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function main(): Promise<void> {
  const rpcUrl = required("RPC_URL");
  const lendingMarket = new PublicKey(required("KAMINO_LENDING_MARKET"));
  const connection = new Connection(rpcUrl, "processed");
  const market = await KaminoMarket.load(
    connection,
    lendingMarket,
    400,
    PROGRAM_ID,
  );
  if (!market)
    throw new Error(
      `Kamino lending market ${lendingMarket.toBase58()} was not found`,
    );

  const reserve = market.getReserveByMint(WSOL_MINT);
  if (!reserve) {
    const supportedMints = market
      .getReserves()
      .map((item) => item.getLiquidityMint().toBase58())
      .join(", ");
    throw new Error(
      `No WSOL reserve exists in this market. Available liquidity mints: ${supportedMints}`,
    );
  }

  console.table({
    "Kamino lending market": market.getAddress().toBase58(),
    "Kamino WSOL reserve": reserve.address.toBase58(),
    "WSOL mint": reserve.getLiquidityMint().toBase58(),
    "Token program": reserve.getLiquidityTokenProgram().toBase58(),
    "Available liquidity (raw)": reserve
      .getLiquidityAvailableAmount()
      .floor()
      .toFixed(0),
  });
  console.log(
    `\nCopy this optional safety pin into .env:\nKAMINO_WSOL_RESERVE=${reserve.address.toBase58()}`,
  );
}

main().catch((error: unknown) => {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
});
