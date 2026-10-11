import { DEADBAND_DIVISOR, WIN_FEE_RATE } from "../protocol/deployment.js";
import type { Instrument } from "../protocol/schemas.js";
import { rawToNumber } from "../lib/units.js";

// Papertrade's asymmetric-impact settlement (docs: "Asymmetric impact PnL").
export type ImpactParams = {
  baseRate: number;
  rateMultiplier: number;
  positionMultiplier: number;
  referenceNotional: number;
  bustBuffer: number;
};

export const impactParams = (instrument: Instrument): ImpactParams => ({
  baseRate: rawToNumber(instrument.baseRateRaw),
  rateMultiplier: rawToNumber(instrument.rateMultiplierRaw),
  positionMultiplier: rawToNumber(instrument.positionMultiplierRaw),
  referenceNotional: rawToNumber(instrument.referenceNotionalRaw),
  bustBuffer: rawToNumber(instrument.bustBufferRaw),
});

// scale = (1 − baseRate) / (1 + 1/(move·rateMultiplier) + referenceNotional/(1e6·move·positionMultiplier))
export const impactScale = (move: number, params: ImpactParams): number => {
  if (move <= 0) return 0;
  const term1 = 1 / (move * params.rateMultiplier);
  const term2 = params.referenceNotional / (1e6 * move * params.positionMultiplier);
  return (1 - params.baseRate) / (1 + term1 + term2);
};

export type CloseSettlement = {
  rawPnl: number;
  netPnl: number;
  // Fraction of the raw gain the trader keeps (1 for losses).
  keepFraction: number;
};

export const settleClose = (
  input: { isLong: boolean; notional: number; entry: number; exit: number },
  params: ImpactParams,
  winFeeRate = WIN_FEE_RATE,
): CloseSettlement => {
  const direction = input.isLong ? 1 : -1;
  const rawPnl = (input.notional * direction * (input.exit - input.entry)) / input.entry;
  if (rawPnl <= 0) return { rawPnl, netPnl: rawPnl, keepFraction: 1 };

  // Deadband: measure the win as if exit were entry/50000 less favourable.
  const adjustedExit = input.exit - (direction * input.entry) / DEADBAND_DIVISOR;
  const deadbandPnl = (input.notional * direction * (adjustedExit - input.entry)) / input.entry;
  if (deadbandPnl <= 0) return { rawPnl, netPnl: 0, keepFraction: 0 };

  const move = Math.abs(adjustedExit - input.entry) / input.entry;
  const netPnl = deadbandPnl * impactScale(move, params) * (1 - winFeeRate);
  return { rawPnl, netPnl, keepFraction: netPnl / rawPnl };
};

// Hard-bust trigger: zero-equity price moved toward entry by the bust buffer.
export const estimateBustPrice = (entry: number, leverage: number, isLong: boolean, bustBuffer: number): number =>
  isLong ? entry * (1 - 1 / leverage + bustBuffer) : entry * (1 + 1 / leverage - bustBuffer);

export type Quote = {
  notionalUsd: number;
  sizeAsset: number;
  entryPrice: number;
  bustPrice: number;
  adverseMoveToBustPct: number;
  keepCurve: { movePct: number; keepFraction: number; netPnlUsd: number }[];
  scenario: (CloseSettlement & { exitPrice: number }) | null;
};

const CURVE_MOVES_PCT = [0.05, 0.1, 0.2, 0.5, 1, 2, 5];

export const buildQuote = (
  input: { isLong: boolean; marginUsd: number; leverage: number; entryPrice: number; exitPrice?: number },
  params: ImpactParams,
): Quote => {
  const notional = input.marginUsd * input.leverage;
  const bustPrice = estimateBustPrice(input.entryPrice, input.leverage, input.isLong, params.bustBuffer);
  const favourable = (pct: number) => input.entryPrice * (1 + ((input.isLong ? 1 : -1) * pct) / 100);
  return {
    notionalUsd: notional,
    sizeAsset: notional / input.entryPrice,
    entryPrice: input.entryPrice,
    bustPrice,
    adverseMoveToBustPct: (Math.abs(bustPrice - input.entryPrice) / input.entryPrice) * 100,
    keepCurve: CURVE_MOVES_PCT.map((movePct) => {
      const settled = settleClose({ isLong: input.isLong, notional, entry: input.entryPrice, exit: favourable(movePct) }, params);
      return { movePct, keepFraction: settled.keepFraction, netPnlUsd: settled.netPnl };
    }),
    scenario:
      input.exitPrice === undefined
        ? null
        : {
            exitPrice: input.exitPrice,
            ...settleClose({ isLong: input.isLong, notional, entry: input.entryPrice, exit: input.exitPrice }, params),
          },
  };
};
