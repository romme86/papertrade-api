import { z } from "zod";
import type { CandleCoin, MinuteRow } from "./types.js";

// Hyperliquid keeps only about the newest 5000 candles per interval
// (≈3.5 days of minutes) and answers an over-long range with the newest ones.
export const HL_RETAINED_MINUTES = 5_000;

export type HyperliquidCandles = {
  /** Closed 1-minute candles with open time in [from, to); takerBuy is NaN (HL doesn't publish it). */
  minuteRows: (coin: CandleCoin, from: number, to: number, now: number) => Promise<MinuteRow[]>;
};

// t = candle open, T = candle close; the newest candle is still forming.
const Candle = z.object({ t: z.number(), T: z.number(), o: z.string(), h: z.string(), l: z.string(), c: z.string(), v: z.string() });

export const createHyperliquidCandles = (infoUrl: string, fetchImpl: typeof fetch = fetch): HyperliquidCandles => ({
  minuteRows: async (coin, from, to, now) => {
    const response = await fetchImpl(infoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1m", startTime: from, endTime: to - 1 } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Hyperliquid candleSnapshot ${coin} returned ${response.status}`);
    return z
      .array(Candle)
      .parse(await response.json())
      .filter((k) => k.t >= from && k.t < to && k.T < now)
      .map((k): MinuteRow => [k.t, Number(k.o), Number(k.h), Number(k.l), Number(k.c), Number(k.v), NaN]);
  },
});
