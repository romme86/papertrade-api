import type { MarketSymbol } from "../protocol/deployment.js";

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
export const DAY_MINUTES = 1_440;

// Same layout as Cassandrina's backtest day blocks (apps/webapp/lib/backtests):
// one block per coin and UTC day, 1440 minutes × these fields as float64
// little-endian, minute-major. NaN means no candle for that minute.
export const CANDLE_FIELDS = ["open", "high", "low", "close", "volume", "takerBuy"] as const;
export type CandleField = (typeof CANDLE_FIELDS)[number];
export const FIELDS = CANDLE_FIELDS.length;
export const DAY_BYTES = DAY_MINUTES * FIELDS * 8;

// binance = USDⓈ-M perps (what Cassandrina's backtests run on, deep history);
// hyperliquid = the venue whose mid Papertrade fills at (kept from first sync on).
export const candleSources = ["binance", "hyperliquid"] as const;
export type CandleSource = (typeof candleSources)[number];
export type CandleCoin = MarketSymbol;

/** [openTime, open, high, low, close, volume, takerBuyVolume]; takerBuy is NaN where the venue doesn't publish it. */
export type MinuteRow = [time: number, open: number, high: number, low: number, close: number, volume: number, takerBuy: number];
/** Realised funding rate per settlement. */
export type FundingPoint = [time: number, rate: number];

export const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
/** Open time of the newest minute that has fully closed. */
export const lastClosedMinute = (now: number) => Math.floor(now / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
export const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
