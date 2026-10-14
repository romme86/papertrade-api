import type { Logger } from "../lib/logger.js";
import type { BinanceFutures } from "./binance.js";
import { applyRows, emptyDay, groupByDay } from "./dayBlock.js";
import { HL_RETAINED_MINUTES, type HyperliquidCandles } from "./hyperliquid.js";
import { syncedThrough, type CandleStore } from "./store.js";
import { DAY_MINUTES, DAY_MS, dayOf, lastClosedMinute, MINUTE_MS, type CandleCoin, type MinuteRow } from "./types.js";

// A day that ended this long ago counts as complete even if its last minutes
// never came back (venue outage), so it isn't re-fetched forever.
const SETTLE_MS = 10 * 60_000;
// A past month with at least this many missing days comes from the archive
// (one ~2 MB streamed download) rather than one REST call per day.
const ARCHIVE_MIN_DAYS = 3;
const FUNDING_REFRESH_MS = 60 * 60_000;

export type SyncJob = "binance" | "hyperliquid" | "funding";
export type JobStatus = { running: boolean; lastRunAt: number | null; lastOkAt: number | null; lastError: string | null };
export type CandleSyncStatus = Record<SyncJob, JobStatus>;

export type CandleSyncDeps = {
  store: CandleStore;
  binance: BinanceFutures;
  hyperliquid: HyperliquidCandles;
  coins: readonly CandleCoin[];
  /** Complete days of Binance history to keep before today. */
  backfillDays: number;
  logger: Logger;
  now?: () => number;
};

const settledSynced = (day: number, lastMinute: number, now: number) =>
  (day + 1) * DAY_MS <= now - SETTLE_MS ? DAY_MINUTES : lastMinute + 1;

/** Merge rows into one stored day and record how far that day is synced. */
const storeRows = async (deps: CandleSyncDeps, source: "binance" | "hyperliquid", coin: CandleCoin, day: number, rows: MinuteRow[], have: number, now: number) => {
  const block = (have > 0 ? await deps.store.readDay(source, coin, day) : null) ?? emptyDay();
  const last = applyRows(block, day, rows);
  const synced = Math.max(have, settledSynced(day, last, now));
  if (synced > have || rows.length) await deps.store.writeDay(source, coin, day, block, synced);
};

const monthOf = (day: number) => {
  const date = new Date(day * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
};

type Pending = { day: number; have: number; expected: number };

/** Binance: every minute from `backfillDays` before today up to the last closed one. */
export const syncBinanceCoin = async (deps: CandleSyncDeps, coin: CandleCoin, now: number) => {
  const lastMinute = lastClosedMinute(now);
  const today = dayOf(lastMinute);
  const coverage = await deps.store.coverage("binance", coin);

  const months = new Map<string, Pending[]>();
  for (let day = today - deps.backfillDays; day <= today; day++) {
    const expected = day < today ? DAY_MINUTES : (lastMinute - day * DAY_MS) / MINUTE_MS + 1;
    const have = coverage.get(day)?.synced ?? 0;
    if (have >= expected) continue;
    const { year, month } = monthOf(day);
    const key = `${year}-${month}`;
    months.set(key, [...(months.get(key) ?? []), { day, have, expected }]);
  }

  const current = monthOf(today);
  for (const pending of months.values()) {
    const { year, month } = monthOf(pending[0]!.day);
    const isCurrent = year === current.year && month === current.month;
    const archived = !isCurrent && pending.length >= ARCHIVE_MIN_DAYS ? await deps.binance.archiveMonth(coin, year, month) : null;
    if (archived) {
      for (const { day } of pending) await deps.store.writeDay("binance", coin, day, archived.get(day) ?? emptyDay(), DAY_MINUTES);
      deps.logger.info("binance archive month stored", { coin, month: `${year}-${String(month).padStart(2, "0")}`, days: pending.length });
      continue;
    }
    for (const { day, have, expected } of pending) {
      const rows = await deps.binance.minuteRows(coin, day * DAY_MS + have * MINUTE_MS, day * DAY_MS + expected * MINUTE_MS);
      await storeRows(deps, "binance", coin, day, rows, have, now);
    }
    if (!isCurrent) deps.logger.info("binance month stored from REST", { coin, month: `${year}-${String(month).padStart(2, "0")}`, days: pending.length });
  }
};

/** Hyperliquid: everything since the last synced minute that HL still retains. */
export const syncHyperliquidCoin = async (deps: CandleSyncDeps, coin: CandleCoin, now: number) => {
  const coverage = await deps.store.coverage("hyperliquid", coin);
  const through = syncedThrough(coverage);
  const end = lastClosedMinute(now) + MINUTE_MS;
  const from = Math.max(through ?? 0, end - HL_RETAINED_MINUTES * MINUTE_MS);
  if (from >= end) return;
  const rows = await deps.hyperliquid.minuteRows(coin, from, end, now);
  if (through === null && rows.length) deps.logger.info("hyperliquid capture started", { coin, from: new Date(rows[0]![0]).toISOString() });
  for (const [day, dayRows] of groupByDay(rows)) await storeRows(deps, "hyperliquid", coin, day, dayRows, coverage.get(day)?.synced ?? 0, now);
};

/** Binance funding settlements, topped up from the last stored one. */
export const syncFundingCoin = async (deps: CandleSyncDeps, coin: CandleCoin, now: number) => {
  const stored = await deps.store.readFunding(coin);
  const since = stored.length ? stored[stored.length - 1]![0] + 1 : (dayOf(lastClosedMinute(now)) - deps.backfillDays) * DAY_MS;
  const fresh = (await deps.binance.funding(coin, since)).filter(([time]) => time >= since);
  if (fresh.length) await deps.store.writeFunding(coin, [...stored, ...fresh]);
};

export type CandleSync = {
  start: (pollMs: number) => void;
  stop: () => void;
  /** One pass of a job over every coin; a no-op while that job is already running. */
  run: (job: SyncJob) => Promise<void>;
  status: () => CandleSyncStatus;
};

export const createCandleSync = (deps: CandleSyncDeps): CandleSync => {
  const now = deps.now ?? Date.now;
  const jobs: Record<SyncJob, (coin: CandleCoin, at: number) => Promise<void>> = {
    binance: (coin, at) => syncBinanceCoin(deps, coin, at),
    hyperliquid: (coin, at) => syncHyperliquidCoin(deps, coin, at),
    funding: (coin, at) => syncFundingCoin(deps, coin, at),
  };
  const state = Object.fromEntries(
    (Object.keys(jobs) as SyncJob[]).map((job) => [job, { running: false, lastRunAt: null, lastOkAt: null, lastError: null }]),
  ) as CandleSyncStatus;
  const timers: NodeJS.Timeout[] = [];

  // Each job runs on its own clock so the Binance backfill never delays the
  // Hyperliquid capture; a tick is skipped while the previous one still runs.
  const tick = async (job: SyncJob) => {
    const status = state[job];
    if (status.running) return;
    status.running = true;
    status.lastRunAt = now();
    const errors: string[] = [];
    for (const coin of deps.coins) {
      try {
        await jobs[job](coin, now());
      } catch (error) {
        errors.push(`${coin}: ${(error as Error).message}`);
      }
    }
    status.running = false;
    if (errors.length) {
      status.lastError = errors.join("; ");
      deps.logger.warn("candle sync failed", { job, error: status.lastError });
    } else {
      status.lastOkAt = now();
      status.lastError = null;
    }
  };

  return {
    start: (pollMs) => {
      for (const job of Object.keys(jobs) as SyncJob[]) {
        void tick(job);
        timers.push(setInterval(() => void tick(job), job === "funding" ? FUNDING_REFRESH_MS : pollMs).unref());
      }
    },
    stop: () => timers.splice(0).forEach(clearInterval),
    run: tick,
    status: () => structuredClone(state),
  };
};
