import { MARKETS, type MarketSymbol } from "../protocol/deployment.js";
import type { Instrument, TradingState } from "../protocol/schemas.js";

export class MarketError extends Error {}

export const instrumentFor = (state: TradingState, market: MarketSymbol): Instrument => {
  const { instrumentId } = MARKETS[market];
  const instrument = state.instruments.find((item) => item.id === instrumentId);
  if (!instrument || instrument.symbol !== market) {
    throw new MarketError(`Instrument ${instrumentId} is not ${market} in the live trading state`);
  }
  return instrument;
};

export const symbolForInstrument = (instrumentId: number): MarketSymbol | null =>
  (Object.entries(MARKETS).find(([, market]) => market.instrumentId === instrumentId)?.[0] as MarketSymbol | undefined) ?? null;
