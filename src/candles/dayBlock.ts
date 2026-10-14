import { DAY_MINUTES, DAY_MS, dayOf, FIELDS, MINUTE_MS, type MinuteRow } from "./types.js";

const CLOSE = 3;

export const emptyDay = (): Float64Array => new Float64Array(DAY_MINUTES * FIELDS).fill(NaN);

/** Writes the rows that fall inside `day` into its block; returns the highest minute index written, or -1. */
export const applyRows = (block: Float64Array, day: number, rows: readonly MinuteRow[]): number => {
  const start = day * DAY_MS;
  let last = -1;
  for (const [time, ...values] of rows) {
    const minute = (time - start) / MINUTE_MS;
    if (!Number.isInteger(minute) || minute < 0 || minute >= DAY_MINUTES) continue;
    // takerBuy may legitimately be NaN (Hyperliquid has none); OHLCV may not
    if (!values.slice(0, FIELDS - 1).every(Number.isFinite)) continue;
    block.set(values, minute * FIELDS);
    last = Math.max(last, minute);
  }
  return last;
};

/** Rows keyed by the UTC day of their open time, days ascending. */
export const groupByDay = (rows: readonly MinuteRow[]): Map<number, MinuteRow[]> => {
  const days = new Map<number, MinuteRow[]>();
  for (const row of rows) {
    const day = dayOf(row[0]);
    const list = days.get(day);
    if (list) list.push(row);
    else days.set(day, [row]);
  }
  return new Map([...days].sort(([a], [b]) => a - b));
};

/** Adds rows to per-day blocks, creating a day's block on its first row. */
export const addToBlocks = (blocks: Map<number, Float64Array>, rows: readonly MinuteRow[]): void => {
  for (const [day, dayRows] of groupByDay(rows)) {
    let block = blocks.get(day);
    if (!block) blocks.set(day, (block = emptyDay()));
    applyRows(block, day, dayRows);
  }
};

export const filledMinutes =(block: Float64Array): number => {
  let filled = 0;
  for (let m = 0; m < DAY_MINUTES; m++) if (Number.isFinite(block[m * FIELDS + CLOSE])) filled++;
  return filled;
};
