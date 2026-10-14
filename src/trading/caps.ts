import type { RiskLimits } from "../config.js";
import { parseUsd } from "../lib/units.js";

// Our margin caps grow with the account's realised profit: a caller can
// compound its winnings, but a trade never risks more than the configured
// base plus what the account has won. Losses never shrink the base.
export type MarginCaps = { perTradeRaw: bigint; totalRaw: bigint; profitRaw: bigint };

export const marginCaps = (limits: RiskLimits, realizedPnlRaw: bigint | null): MarginCaps => {
  const profitRaw = realizedPnlRaw !== null && realizedPnlRaw > 0n ? realizedPnlRaw : 0n;
  return {
    perTradeRaw: parseUsd(limits.maxMarginUsd) + profitRaw,
    totalRaw: parseUsd(limits.maxTotalMarginUsd) + profitRaw,
    profitRaw,
  };
};
