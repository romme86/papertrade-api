import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { applyRows, emptyDay } from "../src/candles/dayBlock.js";
import { createCandleStore } from "../src/candles/store.js";
import { DAY_BYTES, DAY_MINUTES, DAY_MS, dayOf, FIELDS, isoDay, MINUTE_MS, type MinuteRow } from "../src/candles/types.js";
import { silentLogger } from "../src/lib/logger.js";
import { limits, makeHarness, NOW, walletAccount } from "./harness.js";

const TOKEN = "t".repeat(40);
const TODAY = dayOf(NOW);
const row = (time: number): MinuteRow => [time, 10, 12, 9, 11, 5, 2];

const setup = async () => {
  const store = createCandleStore(mkdtempSync(join(tmpdir(), "candles-")));
  // yesterday complete, today up to NOW (12:00 UTC)
  for (const day of [TODAY - 1, TODAY]) {
    const block = emptyDay();
    const minutes = day === TODAY ? 720 : DAY_MINUTES;
    const rows: MinuteRow[] = [];
    for (let m = 0; m < minutes; m++) if (m !== 5) rows.push(row(day * DAY_MS + m * MINUTE_MS));
    applyRows(block, day, rows);
    await store.writeDay("binance", "BTC", day, block, minutes);
  }
  await store.writeFunding("BTC", [[TODAY * DAY_MS - 8 * 3_600_000, 0.0001], [TODAY * DAY_MS, -0.00005]]);

  const h = makeHarness({ liveTrading: false });
  const app = createApp({
    config: { apiToken: TOKEN, liveTrading: false, limits },
    wallet: walletAccount,
    query: h.query,
    stream: h.stream,
    hyperliquid: h.hyperliquid,
    hyperevm: { computeDepositProxy: async () => "0x1111111111111111111111111111111111111111" },
    session: h.session,
    executor: h.executor,
    paper: h.paper,
    store: h.store,
    candles: { store, sync: null },
    logger: silentLogger,
    now: () => NOW,
  });
  return (path: string, token: string | null = TOKEN) => app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
};

describe("candle routes", () => {
  it("need the bearer token", async () => {
    const call = await setup();
    expect((await call("/v1/candles", null)).status).toBe(401);
  });

  it("report coverage per source and coin", async () => {
    const call = await setup();
    const body = (await (await call("/v1/candles")).json()) as Record<string, any>;
    expect(body.fields).toEqual(["open", "high", "low", "close", "volume", "takerBuy"]);
    expect(body.coverage.binance.BTC).toEqual({
      firstDay: isoDay(TODAY - 1),
      lastDay: isoDay(TODAY),
      days: 2,
      syncedThrough: new Date(NOW).toISOString(),
      filledMinutes: DAY_MINUTES - 1 + 719,
      incompleteDays: 1,
    });
    expect(body.coverage.hyperliquid.ETH).toMatchObject({ days: 0, syncedThrough: null });
    expect(body.sync).toBeNull();
  });

  it("serve columns with null for missing minutes", async () => {
    const call = await setup();
    const from = TODAY * DAY_MS + 3 * MINUTE_MS;
    const res = await call(`/v1/candles/binance/btc?from=${from}&to=${new Date(from + 4 * MINUTE_MS).toISOString()}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({ source: "binance", coin: "BTC", from, to: from + 4 * MINUTE_MS, length: 4, truncated: false, syncedThrough: NOW });
    expect(body.columns.close).toEqual([11, 11, null, 11]);
    expect(body.columns.takerBuy).toEqual([2, 2, null, 2]);
  });

  it("cap a range at seven days and at the last closed minute", async () => {
    const call = await setup();
    const long = (await (await call(`/v1/candles/binance/BTC?from=${NOW - 30 * DAY_MS}&to=${NOW}`)).json()) as Record<string, any>;
    expect(long).toMatchObject({ length: 7 * DAY_MINUTES, truncated: true, to: NOW - 23 * DAY_MS });
    const recent = (await (await call(`/v1/candles/binance/BTC?from=${NOW - 10 * MINUTE_MS}`)).json()) as Record<string, any>;
    expect(recent).toMatchObject({ to: NOW, length: 10, truncated: true });
  });

  it("reject bad parameters", async () => {
    const call = await setup();
    expect((await call("/v1/candles/kraken/BTC?from=0")).status).toBe(400);
    expect((await call("/v1/candles/binance/SOL?from=0")).status).toBe(400);
    expect((await call("/v1/candles/binance/BTC?from=yesterday")).status).toBe(400);
    expect((await call("/v1/candles/binance/BTC")).status).toBe(400);
    expect((await call(`/v1/candles/binance/BTC?from=${NOW + DAY_MS}`)).status).toBe(400);
  });

  it("serve a stored day as raw float64 bytes", async () => {
    const call = await setup();
    const res = await call(`/v1/candles/binance/BTC/days/${isoDay(TODAY)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-synced-minutes")).toBe("720");
    expect(res.headers.get("x-filled-minutes")).toBe("719");
    const block = new Float64Array(await res.arrayBuffer());
    expect(block.byteLength).toBe(DAY_BYTES);
    expect(Array.from(block.subarray(0, FIELDS))).toEqual([10, 12, 9, 11, 5, 2]);
    expect(block[5 * FIELDS]).toBeNaN();

    expect((await call(`/v1/candles/binance/BTC/days/${TODAY - 1}`)).status).toBe(200);
    expect((await call(`/v1/candles/hyperliquid/BTC/days/${TODAY}`)).status).toBe(404);
    expect((await call("/v1/candles/binance/BTC/days/14-10-2026")).status).toBe(400);
  });

  it("serve Binance funding history in a time range", async () => {
    const call = await setup();
    const all = (await (await call("/v1/funding-rates/btc")).json()) as Record<string, any>;
    expect(all).toEqual({ source: "binance", coin: "BTC", points: [[TODAY * DAY_MS - 8 * 3_600_000, 0.0001], [TODAY * DAY_MS, -0.00005]] });
    const recent = (await (await call(`/v1/funding-rates/BTC?from=${TODAY * DAY_MS}`)).json()) as Record<string, any>;
    expect(recent.points).toEqual([[TODAY * DAY_MS, -0.00005]]);
  });
});
