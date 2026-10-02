const TEN = 10n;

/** Convert a human decimal string into an exact integer token amount. */
export function toAtomic(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`Invalid token-decimal count: ${decimals}`);
  }

  const input = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(input);
  if (!match) {
    throw new Error(`Invalid non-negative decimal amount: ${value}`);
  }

  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) {
    throw new Error(`${value} has more than ${decimals} decimal places`);
  }

  const scale = TEN ** BigInt(decimals);
  const fractionalAtomic = BigInt(
    (fraction + "0".repeat(decimals)).slice(0, decimals) || "0",
  );
  return BigInt(whole) * scale + fractionalAtomic;
}

/** Print an atomic amount without ever passing through IEEE-754 number arithmetic. */
export function formatAtomic(
  amount: bigint,
  decimals: number,
  maximumFractionDigits = decimals,
): string {
  if (
    decimals < 0 ||
    maximumFractionDigits < 0 ||
    maximumFractionDigits > decimals
  ) {
    throw new Error("Invalid decimal formatting arguments");
  }

  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const scale = TEN ** BigInt(decimals);
  const whole = absolute / scale;
  const rawFraction = (absolute % scale).toString().padStart(decimals, "0");
  const fraction = rawFraction
    .slice(0, maximumFractionDigits)
    .replace(/0+$/, "");
  return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

export function toSafeNumber(amount: bigint, label: string): number {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript's safe integer range`);
  }
  return Number(amount);
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Division denominator must be positive");
  }
  if (numerator < 0n) {
    throw new Error("ceilDiv only supports non-negative integers");
  }
  return (numerator + denominator - 1n) / denominator;
}
