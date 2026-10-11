import type { StateStore } from "../state/store.js";

// Realized PnL since 00:00 UTC, measured against the wallet's lifetime
// realized PnL at the first observation of each UTC day.
export const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export const realizedTodayRaw = async (store: StateStore, lifetimeRealizedRaw: bigint, nowMs = Date.now()): Promise<bigint> => {
  const day = utcDay(nowMs);
  const daily = store.read().daily;
  if (daily?.day === day) return lifetimeRealizedRaw - BigInt(daily.realizedPnlBaselineRaw);
  await store.update((state) => ({ ...state, daily: { day, realizedPnlBaselineRaw: lifetimeRealizedRaw.toString() } }));
  return 0n;
};
