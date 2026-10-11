import type { RiskLimits } from "../config.js";
import { parseUsd } from "../lib/units.js";
import type { Instrument, TradingState } from "../protocol/schemas.js";
import type { WalletState } from "../clients/walletState.js";

export type OpenCheckInput = {
  marginRaw: bigint;
  leverage: number;
  instrument: Instrument;
  trading: TradingState;
  wallet: WalletState | null;
  walletAgeMs: number | null;
  sessionValidForMs: number | null;
  killSwitchEngaged: boolean;
  realizedTodayRaw: bigint;
  limits: RiskLimits;
  snapshotMaxAgeMs: number;
};

export type Violation = { code: string; message: string };

const MIN_SESSION_VALIDITY_MS = 60 * 60_000;

// Every reason an open would be refused, by Papertrade or by our own limits.
export const checkOpen = (input: OpenCheckInput): Violation[] => {
  const v: Violation[] = [];
  const add = (code: string, message: string) => v.push({ code, message });
  const { instrument, trading, marginRaw, leverage, limits, wallet } = input;
  const notionalRaw = marginRaw * BigInt(leverage);

  if (input.killSwitchEngaged) add("kill_switch", "Kill switch is engaged; only closes are allowed");
  if (trading.tradingPaused) add("trading_paused", "Papertrade has paused all opens");
  if (trading.intake.pausedActions.includes("openPosition")) add("intake_paused", "Papertrade intake for openPosition is paused");
  if (!instrument.openable) add("market_closed", `${instrument.symbol} is not open for new positions`);

  if (!Number.isInteger(leverage) || leverage < 1) add("leverage_invalid", "Leverage must be a positive integer");
  if (leverage > instrument.maxLeverage) add("leverage_market_max", `Leverage exceeds the market max ${instrument.maxLeverage}x`);
  if (marginRaw < trading.minimumTradeSizeRaw) add("margin_below_min", "Margin is below Papertrade's minimum");
  if (notionalRaw < trading.minimumOpenNotionalRaw) add("notional_below_min", "Position value (margin × leverage) is below Papertrade's minimum");
  if (notionalRaw > instrument.maxPositionNotionalRaw) add("notional_above_max", "Position value exceeds the market maximum");

  if (marginRaw > parseUsd(limits.maxMarginUsd)) add("limit_margin", `Margin exceeds MAX_MARGIN_USD ${limits.maxMarginUsd}`);
  if (leverage > limits.maxLeverage) add("limit_leverage", `Leverage exceeds MAX_LEVERAGE ${limits.maxLeverage}`);
  if (input.realizedTodayRaw <= -parseUsd(limits.dailyLossLimitUsd)) add("limit_daily_loss", `Daily realized loss reached DAILY_LOSS_LIMIT_USD ${limits.dailyLossLimitUsd}`);

  if (!wallet) {
    add("wallet_unknown", "No wallet snapshot from Papertrade yet");
  } else {
    if (input.walletAgeMs === null || input.walletAgeMs > input.snapshotMaxAgeMs) add("wallet_stale", "Wallet snapshot is stale");
    const pendingOpens = wallet.operations.filter((op) => op.action === "openPosition").length;
    if (wallet.openPositions.length + pendingOpens >= limits.maxOpenPositions) add("limit_positions", `Open + pending positions reached MAX_OPEN_POSITIONS ${limits.maxOpenPositions}`);
    if (wallet.locked + wallet.funds.reservedBalance + marginRaw > parseUsd(limits.maxTotalMarginUsd)) add("limit_total_margin", `Total margin would exceed MAX_TOTAL_MARGIN_USD ${limits.maxTotalMarginUsd}`);
    if (marginRaw > wallet.funds.availableBalance) add("insufficient_funds", "Margin exceeds the available balance");
  }

  if (input.sessionValidForMs === null || input.sessionValidForMs < MIN_SESSION_VALIDITY_MS) {
    add("session_invalid", "No registered session key valid for at least another hour");
  }
  return v;
};
