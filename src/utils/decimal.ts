// Exact decimal arithmetic for report values, on BigInt scaled integers.
// Balance × price must not go through binary doubles: an 18-decimal balance
// or a half-cent product (1.015 × 1) would otherwise round to the wrong cent.

interface Scaled {
  // value = digits / 10^scale
  digits: bigint;
  scale: number;
}

// Parses a non-negative plain decimal such as "1072.624119" or "0.93114999".
function parseDecimal(text: string): Scaled {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`Not a decimal amount: "${text}"`);
  const fraction = m[2] ?? "";
  return { digits: BigInt(m[1] + fraction), scale: fraction.length };
}

// The exact decimal expansion of a finite non-negative double's shortest
// round-trip representation (String(n)), also for exponent forms like 1e-7.
export function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Not a valid amount: ${value}`);
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
  if (!m) throw new Error(`Not a valid amount: ${value}`);
  let digits = m[1] + (m[2] ?? "");
  let point = m[1].length + Number(m[3] ?? "0");
  if (point <= 0) {
    digits = "0".repeat(1 - point) + digits;
    point = 1;
  } else if (point > digits.length) {
    digits = digits + "0".repeat(point - digits.length);
  }
  const integer = digits.slice(0, point);
  const fraction = digits.slice(point);
  return fraction ? `${integer}.${fraction}` : integer;
}

// amount × price, exact, rounded once to 2 decimals, half-up (…5 rounds
// away from zero; both factors are non-negative). Returns e.g. "1862299.98".
export function multiplyToCents(amount: string, price: string): string {
  const a = parseDecimal(amount);
  const p = parseDecimal(price);
  const denominator = 10n ** BigInt(a.scale + p.scale);
  const product = a.digits * p.digits * 100n;
  const cents = (2n * product + denominator) / (2n * denominator);
  const text = cents.toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

// "1862299.98" -> "1'862'299.98" (Swiss thousands separators).
export function formatSwissDecimal(value: string): string {
  const [integer, fraction] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
