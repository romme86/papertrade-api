import { Hono } from "hono";
import { z } from "zod";
import { readColumns } from "../../candles/columns.js";
import { syncedThrough, type Coverage } from "../../candles/store.js";
import { CANDLE_FIELDS, candleSources, DAY_MINUTES, DAY_MS, isoDay, lastClosedMinute, MINUTE_MS } from "../../candles/types.js";
import { marketSymbols, type MarketSymbol } from "../../protocol/deployment.js";
import { json } from "../respond.js";
import type { AppDeps } from "../deps.js";

const MAX_RANGE_MINUTES = 7 * DAY_MINUTES;

const Source = z.enum(candleSources);
const Coin = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.enum(marketSymbols as [MarketSymbol, ...MarketSymbol[]]));

/** Epoch milliseconds or an ISO date/time. */
const Instant = z.string().transform((value, ctx) => {
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (Number.isFinite(ms)) return ms;
  ctx.addIssue({ code: "custom", message: "Expected epoch milliseconds or an ISO date" });
  return z.NEVER;
});

/** UTC day number or YYYY-MM-DD. */
const Day = z.string().transform((value, ctx) => {
  if (/^\d+$/.test(value)) return Number(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))) return Date.parse(`${value}T00:00:00Z`) / DAY_MS;
  ctx.addIssue({ code: "custom", message: "Expected a UTC day number or YYYY-MM-DD" });
  return z.NEVER;
});

const RangeQuery = z.object({ from: Instant, to: Instant.optional() });
const FundingQuery = z.object({ from: Instant.optional(), to: Instant.optional() });

const coverageView = (coverage: Coverage) => {
  const days = [...coverage.keys()].sort((a, b) => a - b);
  const lastDay = days[days.length - 1];
  const through = syncedThrough(coverage);
  return {
    firstDay: days.length ? isoDay(days[0]!) : null,
    lastDay: lastDay === undefined ? null : isoDay(lastDay),
    days: days.length,
    syncedThrough: through === null ? null : new Date(through).toISOString(),
    filledMinutes: [...coverage.values()].reduce((sum, day) => sum + day.filled, 0),
    // days before the newest with minutes the venue never printed (or that predate capture)
    incompleteDays: days.filter((day) => day !== lastDay && coverage.get(day)!.filled < DAY_MINUTES).length,
  };
};

export const candleRoutes = (deps: AppDeps) => {
  const now = deps.now ?? Date.now;
  const { store, sync } = deps.candles;
  const app = new Hono();

  app.get("/candles", async (c) => {
    const coverage: Record<string, Record<string, ReturnType<typeof coverageView>>> = {};
    for (const source of candleSources) {
      coverage[source] = {};
      for (const coin of marketSymbols) coverage[source][coin] = coverageView(await store.coverage(source, coin));
    }
    return json(c, { intervalMs: MINUTE_MS, fields: CANDLE_FIELDS, maxRangeMinutes: MAX_RANGE_MINUTES, coverage, sync: sync?.status() ?? null });
  });

  // Columns over [from, to), at most MAX_RANGE_MINUTES; page on with from = the returned `to`.
  app.get("/candles/:source/:coin", async (c) => {
    const source = Source.parse(c.req.param("source"));
    const coin = Coin.parse(c.req.param("coin"));
    const query = RangeQuery.parse(c.req.query());
    const from = Math.floor(query.from / MINUTE_MS) * MINUTE_MS;
    const requested = Math.floor((query.to ?? from + DAY_MS) / MINUTE_MS) * MINUTE_MS;
    const to = Math.min(requested, from + MAX_RANGE_MINUTES * MINUTE_MS, lastClosedMinute(now()) + MINUTE_MS);
    if (to <= from) return c.json({ error: { code: "invalid_request", message: "Empty range: `to` must be after `from` and `from` in the past" } }, 400);
    const columns = await readColumns(store, source, coin, from, to);
    const through = syncedThrough(await store.coverage(source, coin));
    return json(c, {
      source,
      coin,
      from,
      to,
      intervalMs: MINUTE_MS,
      length: (to - from) / MINUTE_MS,
      truncated: to < requested,
      syncedThrough: through,
      // NaN serialises to null: a minute with no candle, or not synced yet
      columns: Object.fromEntries(CANDLE_FIELDS.map((field) => [field, Array.from(columns[field])])),
    });
  });

  // One stored day as raw bytes: 1440 minutes × fields, float64 little-endian, NaN = no candle.
  app.get("/candles/:source/:coin/days/:day", async (c) => {
    const source = Source.parse(c.req.param("source"));
    const coin = Coin.parse(c.req.param("coin"));
    const day = Day.parse(c.req.param("day"));
    const block = await store.readDay(source, coin, day);
    if (!block) return c.json({ error: { code: "not_found", message: `No ${source} ${coin} candles stored for ${isoDay(day)}` } }, 404);
    const coverage = (await store.coverage(source, coin)).get(day);
    return c.body(block.buffer as ArrayBuffer, 200, {
      "Content-Type": "application/octet-stream",
      "X-Candle-Day": isoDay(day),
      "X-Candle-Fields": CANDLE_FIELDS.join(","),
      "X-Synced-Minutes": String(coverage?.synced ?? 0),
      "X-Filled-Minutes": String(coverage?.filled ?? 0),
    });
  });

  // Binance perp funding (Papertrade itself charges none).
  app.get("/funding-rates/:coin", async (c) => {
    const coin = Coin.parse(c.req.param("coin"));
    const { from = 0, to = Infinity } = FundingQuery.parse(c.req.query());
    const points = (await store.readFunding(coin)).filter(([time]) => time >= from && time < to);
    return json(c, { source: "binance", coin, points });
  });

  return app;
};
