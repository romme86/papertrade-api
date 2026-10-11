import type { Bbo } from "../clients/hyperliquid.js";
import type { WalletState } from "../clients/walletState.js";
import { formatUsd, priceFromRaw, rawToNumber } from "../lib/units.js";
import type { MarketSymbol } from "../protocol/deployment.js";
import type { Instrument, Position, TradingState } from "../protocol/schemas.js";
import { symbolForInstrument } from "../trading/markets.js";
import { impactParams, settleClose } from "../trading/quote.js";
import type { SessionStatus } from "../trading/session.js";

// Response shapes: human-readable USD/price numbers next to the raw values.

export const instrumentView = (instrument: Instrument, trading: TradingState, bbo: Bbo | null) => {
  const params = impactParams(instrument);
  return {
    market: instrument.symbol,
    instrumentId: instrument.id,
    openable: instrument.openable && !trading.tradingPaused,
    closeOnly: instrument.closeOnly,
    retired: instrument.retired,
    maxLeverage: instrument.maxLeverage,
    maxPositionNotionalUsd: formatUsd(instrument.maxPositionNotionalRaw, 2),
    minimumMarginUsd: formatUsd(trading.minimumTradeSizeRaw, 2),
    minimumNotionalUsd: formatUsd(trading.minimumOpenNotionalRaw, 2),
    impact: { ...params, winFeeRate: 0.02, deadbandBps: 0.2 },
    openInterestRaw: {
      long: instrument.longOiRaw,
      short: instrument.shortOiRaw,
      longCap: instrument.longCapRaw,
      shortCap: instrument.shortCapRaw,
    },
    price: bbo ? { bid: bbo.bid, ask: bbo.ask, mid: bbo.mid, source: "hyperliquid-l2Book", at: bbo.at } : null,
  };
};

export const positionView = (position: Position, trading: TradingState, bbos: Partial<Record<MarketSymbol, Bbo>>) => {
  const instrument = trading.instruments.find((item) => item.id === position.instrumentId);
  const market = symbolForInstrument(position.instrumentId);
  const priceScale = instrument?.priceScale ?? 1n;
  const entry = priceFromRaw(position.entryPriceRaw, priceScale);
  const margin = rawToNumber(position.marginRaw);
  const notional = margin * position.leverage;
  const mark = market ? bbos[market]?.mid ?? null : null;
  const settlement = instrument && mark !== null ? settleClose({ isLong: position.isLong, notional, entry, exit: mark }, impactParams(instrument)) : null;
  return {
    positionId: position.positionId.toString(),
    market,
    side: position.isLong ? "long" : "short",
    useDebt: position.useDebt,
    marginUsd: formatUsd(position.marginRaw, 6),
    leverage: position.leverage,
    notionalUsd: notional,
    entryPrice: entry,
    bustPrice: priceFromRaw(position.bustPriceRaw, priceScale),
    openedAtMs: position.openedAtMs,
    intentId: position.intentId,
    mark,
    // Estimated close-now result, including the win haircut + fee.
    estimatedClose: settlement && { rawPnlUsd: settlement.rawPnl, netPnlUsd: settlement.netPnl, keepFraction: settlement.keepFraction },
  };
};

export const accountView = (state: WalletState, session: SessionStatus, snapshotAgeMs: number | null) => ({
  address: state.address,
  accountRevision: state.accountRevision,
  indexedThroughBlock: state.indexedThroughBlock,
  snapshotAgeMs,
  balances: {
    balanceUsd: formatUsd(state.balance),
    availableUsd: formatUsd(state.funds.availableBalance),
    reservedUsd: formatUsd(state.funds.reservedBalance),
    lockedMarginUsd: formatUsd(state.locked),
    queuedUsd: formatUsd(state.queued),
    availableQueuedUsd: formatUsd(state.funds.availableQueued),
    consumableDebtUsd: formatUsd(state.consumableDebt),
  },
  lifetime: {
    depositedUsd: formatUsd(state.lifetime.depositedRaw),
    withdrawnUsd: formatUsd(state.lifetime.withdrawnRaw),
    realizedPnlUsd: formatUsd(state.lifetime.realizedPnlRaw),
    feesPaidUsd: formatUsd(state.lifetime.feesPaidRaw),
    tradedNotionalUsd: formatUsd(state.lifetime.tradedNotionalRaw, 2),
  },
  paper: {
    balance: formatUsd(state.paper.balance),
    staked: formatUsd(state.paper.staked),
  },
  openPositions: state.openPositions.length,
  pendingOperations: state.operations.map((op) => ({
    intentId: op.intentId,
    action: op.action,
    acceptedAtMs: op.acceptedAtMs,
    deadline: op.deadline.toString(),
    positionIds: op.positionIds?.map(String) ?? null,
  })),
  session,
});
