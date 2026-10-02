import { describe, expect, it } from "vitest";
import { ceilDiv, formatAtomic, toAtomic } from "../src/amount.js";

describe("exact token amounts", () => {
  it("preserves the requested 2.5 WSOL flash amount", () => {
    expect(toAtomic("2.5", 9)).toBe(2_500_000_000n);
    expect(toAtomic("1.1133", 9)).toBe(1_113_300_000n);
    expect(toAtomic("2.500025", 9)).toBe(2_500_025_000n);
  });

  it("rejects lossy decimal input", () => {
    expect(() => toAtomic("1.0000000001", 9)).toThrow(
      "more than 9 decimal places",
    );
    expect(() => toAtomic("-1", 9)).toThrow("Invalid non-negative");
  });

  it("prints values without converting a u64 to Number", () => {
    expect(formatAtomic(3_311_900_000n, 9)).toBe("3.3119");
    expect(formatAtomic(2_500_025_000n, 9)).toBe("2.500025");
    expect(ceilDiv(1n, 3n)).toBe(1n);
  });
});
