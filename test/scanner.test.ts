import { describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import {
  rankEligibleCandidates,
  rankExecutionEligibleCandidates,
  rankTechnicalSimulationCandidates,
  requireBestCandidate,
  requireBestTechnicalSimulationCandidate,
  type EligibleCandidate,
  type ScanCandidate,
  type ScanResult,
  type TechnicalCandidate,
} from "../src/scanner.js";
import type { LstStrategyMode } from "../src/strategies.js";

function candidate(
  id: string,
  mode: LstStrategyMode,
  netAfterBudgetRaw: bigint,
): EligibleCandidate {
  return {
    status: "eligible",
    strategy: { id, mode },
    economics: { expectedNetAfterBudgetRaw: netAfterBudgetRaw },
  } as unknown as EligibleCandidate;
}

function technicalCandidate(
  id: string,
  mode: LstStrategyMode,
  netAfterBudgetRaw: bigint,
): TechnicalCandidate {
  return {
    status: "technical",
    strategy: { id, mode },
    economics: { expectedNetAfterBudgetRaw: netAfterBudgetRaw },
    economicGateReason: "below economic gate",
  } as unknown as TechnicalCandidate;
}

function scan(candidates: ScanCandidate[]): ScanResult {
  return {
    runtime: { walletBalanceRaw: 1_000_000_000n },
    candidates,
  } as unknown as ScanResult;
}

const config = { minGasBalanceRaw: 1n } as BotConfig;

describe("LST scan-only selection", () => {
  it("keeps scan-only candidates in the economic ranking for observation", () => {
    const scanOnly = candidate("research-pool", "scan-only", 50n);
    const execution = candidate("execution-pool", "execution", 10n);

    expect(rankEligibleCandidates([execution, scanOnly])).toEqual([
      scanOnly,
      execution,
    ]);
  });

  it("selects only execution-mode candidates for a plan", () => {
    const scanOnly = candidate("research-pool", "scan-only", 50n);
    const execution = candidate("execution-pool", "execution", 10n);

    expect(rankExecutionEligibleCandidates([scanOnly, execution])).toEqual([
      execution,
    ]);
    expect(requireBestCandidate(scan([scanOnly, execution]), config)).toBe(
      execution,
    );
  });

  it("does not permit a scan-only economic candidate to be selected", () => {
    const scanOnly = candidate("research-pool", "scan-only", 50n);

    expect(() => requireBestCandidate(scan([scanOnly]), config)).toThrow(
      "No economically eligible execution-mode",
    );
  });

  it("selects an execution technical candidate only for no-send simulation", () => {
    const scanOnly = technicalCandidate("research-pool", "scan-only", 90n);
    const technical = technicalCandidate("execution-pool", "execution", -5n);

    expect(rankTechnicalSimulationCandidates([scanOnly, technical])).toEqual([
      technical,
    ]);
    expect(
      requireBestTechnicalSimulationCandidate(
        scan([scanOnly, technical]),
        config,
      ),
    ).toBe(technical);
    expect(() => requireBestCandidate(scan([technical]), config)).toThrow(
      "No economically eligible execution-mode",
    );
  });
});
