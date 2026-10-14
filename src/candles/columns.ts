import type { CandleStore } from "./store.js";
import { CANDLE_FIELDS, DAY_MINUTES, DAY_MS, dayOf, FIELDS, MINUTE_MS, type CandleCoin, type CandleField, type CandleSource } from "./types.js";

export type Columns = Record<CandleField, Float64Array>;

/** One column per field over the minutes [from, to) (both minute-aligned); NaN where there is no candle. */
export const readColumns = async (store: CandleStore, source: CandleSource, coin: CandleCoin, from: number, to: number): Promise<Columns> => {
  const length = (to - from) / MINUTE_MS;
  const columns = Object.fromEntries(CANDLE_FIELDS.map((field) => [field, new Float64Array(length).fill(NaN)])) as Columns;
  for (let day = dayOf(from); day <= dayOf(to - 1); day++) {
    const block = await store.readDay(source, coin, day);
    if (!block) continue;
    const first = Math.max(0, (from - day * DAY_MS) / MINUTE_MS);
    const last = Math.min(DAY_MINUTES, (to - day * DAY_MS) / MINUTE_MS);
    for (let m = first; m < last; m++) {
      const i = (day * DAY_MS + m * MINUTE_MS - from) / MINUTE_MS;
      CANDLE_FIELDS.forEach((field, f) => (columns[field][i] = block[m * FIELDS + f]!));
    }
  }
  return columns;
};
