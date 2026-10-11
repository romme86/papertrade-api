// Papertrade keeps every collateral amount (margin, balances, PnL) as an
// 18-decimal integer, regardless of USDC's 6 on-chain decimals.
export const COLLATERAL_DECIMALS = 18;
const SCALE = 10n ** BigInt(COLLATERAL_DECIMALS);
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d{1,18})?$/;

export class UnitError extends Error {}

export const parseUsd = (value: string | number): bigint => {
  const text = typeof value === "number" ? numberToPlain(value) : value.trim();
  if (!DECIMAL_PATTERN.test(text)) {
    throw new UnitError(`Invalid USD amount "${value}" (max 18 decimals, no sign)`);
  }
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(COLLATERAL_DECIMALS, "0"));
};

export const formatUsd = (raw: bigint, digits = 6): string => {
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(COLLATERAL_DECIMALS, "0").slice(0, digits);
  const trimmed = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
};

// Via the decimal string so values like 814.598 stay exact instead of 814.5980000000001.
export const rawToNumber = (raw: bigint): number => Number(formatUsd(raw, COLLATERAL_DECIMALS));

export const priceFromRaw = (raw: bigint, priceScale: bigint): number => Number(raw) / Number(priceScale);

const numberToPlain = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) throw new UnitError(`Invalid USD amount ${value}`);
  return value.toFixed(COLLATERAL_DECIMALS).replace(/\.?0+$/, "");
};
