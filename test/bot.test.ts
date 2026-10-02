import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { buildFlashRedeemPlan } from "../src/bot.js";
import type { EligibleCandidate } from "../src/scanner.js";

const scanOnlyCandidate = {
  strategy: {
    id: "research-pool",
    mode: "scan-only",
  },
} as unknown as EligibleCandidate;

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
});
