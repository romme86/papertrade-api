import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { streamKlineRows } from "../src/candles/archive.js";
import { createBinanceFutures, type BinanceFutures } from "../src/candles/binance.js";
import { readColumns } from "../src/candles/columns.js";
import { addToBlocks, applyRows, emptyDay, filledMinutes, groupByDay } from "../src/candles/dayBlock.js";
import { createHyperliquidCandles, HL_RETAINED_MINUTES, type HyperliquidCandles } from "../src/candles/hyperliquid.js";
import { createCandleStore, syncedThrough } from "../src/candles/store.js";
import { createCandleSync, syncBinanceCoin, syncFundingCoin, syncHyperliquidCoin, type CandleSyncDeps } from "../src/candles/sync.js";
import { DAY_BYTES, DAY_MINUTES, DAY_MS, dayOf, FIELDS, MINUTE_MS, type FundingPoint, type MinuteRow } from "../src/candles/types.js";
import { silentLogger } from "../src/lib/logger.js";

// Wednesday 2026-10-14 12:30:15 UTC: the last closed minute is 12:29.
const NOW = Date.UTC(2026, 9, 14, 12, 30, 15);
const TODAY = dayOf(NOW);

const tempStore = () => createCandleStore(mkdtempSync(join(tmpdir(), "candles-")));
const row = (time: number, takerBuy = 1): MinuteRow => [time, 100, 102, 99, 100 + ((time / MINUTE_MS) % 7), 3, takerBuy];
const rowsBetween = (from: number, to: number, takerBuy = 1) => {
  const rows: MinuteRow[] = [];
  for (let t = from; t < to; t += MINUTE_MS) rows.push(row(t, takerBuy));
  return rows;
};

type Call = [kind: string, ...args: (string | number)[]];

const fakeBinance = ({ archived = true }: { archived?: boolean } = {}) => {
  const calls: Call[] = [];
  const funding: FundingPoint[] = [];
  for (let t = Date.UTC(2026, 8, 1); t < NOW; t += 8 * 3_600_000) funding.push([t, 0.0001]);
  const binance: BinanceFutures = {
    minuteRows: async (coin, from, to) => {
      calls.push(["rest", coin, from, to]);
      return rowsBetween(from, to);
    },
    archiveMonth: async (coin, year, month) => {
      calls.push(["archive", coin, year, month]);
      if (!archived) return null;
      const blocks = new Map<number, Float64Array>();
      addToBlocks(blocks, rowsBetween(Date.UTC(year, month - 1, 1), Date.UTC(year, month, 1)));
      return blocks;
    },
    funding: async (coin, from) => {
      calls.push(["funding", coin, from]);
      return funding.filter(([t]) => t >= from);
    },
  };
  return { binance, calls };
};

const fakeHyperliquid = () => {
  const calls: Call[] = [];
  const hyperliquid: HyperliquidCandles = {
    minuteRows: async (coin, from, to, now) => {
      calls.push(["hl", coin, from, to]);
      return rowsBetween(from, to, NaN).filter(([t]) => t + MINUTE_MS - 1 < now);
    },
  };
  return { hyperliquid, calls };
};

const syncDeps = (overrides: Partial<CandleSyncDeps> = {}): CandleSyncDeps => ({
  store: tempStore(),
  binance: fakeBinance().binance,
  hyperliquid: fakeHyperliquid().hyperliquid,
  coins: ["BTC", "ETH"],
  backfillDays: 20,
  logger: silentLogger,
  ...overrides,
});

const makeZip = (name: string, content: Uint8Array, method: 0 | 8): Uint8Array => {
  const data = method === 8 ? deflateRawSync(content) : Buffer.from(content);
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(file.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + file.length, 12);
  eocd.writeUInt32LE(30 + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, eocd]);
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("day blocks", () => {
  it("places each minute at its offset and skips rows outside the day or without prices", () => {
    const day = TODAY;
    const block = emptyDay();
    const last = applyRows(block, day, [
      row(day * DAY_MS + 5 * MINUTE_MS),
      row(day * DAY_MS + 10 * MINUTE_MS, NaN),
      [day * DAY_MS + 11 * MINUTE_MS, 1, 1, 1, NaN, 1, 1],
      row((day + 1) * DAY_MS),
      row(day * DAY_MS + 30_000),
    ]);
    expect(last).toBe(10);
    expect(Array.from(block.subarray(5 * FIELDS, 6 * FIELDS))).toEqual(row(day * DAY_MS + 5 * MINUTE_MS).slice(1));
    expect(block[10 * FIELDS + 5]).toBeNaN();
    expect(block[11 * FIELDS + 3]).toBeNaN();
    expect(filledMinutes(block)).toBe(2);
  });

  it("groups rows by UTC day in ascending order", () => {
    const grouped = groupByDay([row((TODAY + 1) * DAY_MS), row(TODAY * DAY_MS), row(TODAY * DAY_MS + MINUTE_MS)]);
    expect([...grouped.keys()]).toEqual([TODAY, TODAY + 1]);
    expect(grouped.get(TODAY)).toHaveLength(2);
  });
});

describe("Binance archive files", () => {
  const header = "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n";
  const start = TODAY * DAY_MS;
  const csv = header + rowsBetween(start, start + 3_000 * MINUTE_MS).map(([t, o, h, l, c, v, tb]) => `${t},${o},${h},${l},${c},${v},${t + 59_999},0,1,${tb},0,0`).join("\n");
  // tiny chunks so the local header and lines straddle chunk boundaries
  async function* chunked(bytes: Uint8Array, size = 7) {
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
  }
  const collect = async (zip: Uint8Array) => {
    const rows: MinuteRow[] = [];
    await streamKlineRows(chunked(zip), (batch) => rows.push(...batch));
    return rows;
  };

  it("streams every row of a deflated entry, skipping the header line", async () => {
    const rows = await collect(makeZip("BTCUSDT-1m-2026-10.csv", new TextEncoder().encode(csv), 8));
    expect(rows).toHaveLength(3_000);
    expect(rows[0]).toEqual(row(start));
    expect(rows[2_999]).toEqual(row(start + 2_999 * MINUTE_MS));
  });

  it("rejects something that is not a deflated zip", async () => {
    await expect(collect(new Uint8Array(64))).rejects.toThrow("Not a zip archive");
    await expect(collect(makeZip("x.csv", new TextEncoder().encode(csv), 0))).rejects.toThrow("Unsupported zip compression 0");
  });
});

describe("Binance client", () => {
  it("pages klines 1500 at a time and keeps the taker-buy volume", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const params = new URL(url).searchParams;
      const from = Number(params.get("startTime")), to = Number(params.get("endTime")) + 1;
      return jsonResponse(rowsBetween(from, to).map(([t, o, h, l, c, v, tb]) => [t, String(o), String(h), String(l), String(c), String(v), t + 59_999, "0", 1, String(tb), "0", "0"]));
    }) as typeof fetch;
    const binance = createBinanceFutures({ restUrl: "https://fapi.test/fapi/v1", archiveUrl: "https://archive.test", fetchImpl, paceMs: 0 });
    const from = TODAY * DAY_MS;
    const rows = await binance.minuteRows("BTC", from, from + 2_000 * MINUTE_MS);
    expect(rows).toHaveLength(2_000);
    expect(rows[1_999]).toEqual(row(from + 1_999 * MINUTE_MS));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/klines?symbol=BTCUSDT&interval=1m&startTime=");
  });

  it("returns null for an archive month Binance hasn't published", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const binance = createBinanceFutures({ restUrl: "https://fapi.test/fapi/v1", archiveUrl: "https://archive.test/klines", fetchImpl, paceMs: 0 });
    expect(await binance.archiveMonth("ETH", 2026, 9)).toBeNull();
    expect(urls).toEqual(["https://archive.test/klines/ETHUSDT/1m/ETHUSDT-1m-2026-09.zip"]);
  });

  it("pages funding until a short page", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const size = calls === 1 ? 1_000 : 3;
      return jsonResponse(Array.from({ length: size }, (_, i) => ({ fundingTime: calls * 1e9 + i, fundingRate: "0.0001" })));
    }) as unknown as typeof fetch;
    const binance = createBinanceFutures({ restUrl: "https://fapi.test/fapi/v1", archiveUrl: "https://archive.test", fetchImpl, paceMs: 0 });
    expect(await binance.funding("BTC", 0)).toHaveLength(1_003);
    expect(calls).toBe(2);
  });
});

describe("Hyperliquid candles client", () => {
  it("asks for 1m candles and drops the forming one", async () => {
    let body: unknown;
    const end = NOW - (NOW % MINUTE_MS);
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return jsonResponse(
        [end - 2 * MINUTE_MS, end - MINUTE_MS, end].map((t) => ({ t, T: t + 59_999, s: "BTC", i: "1m", o: "1", c: "2", h: "3", l: "0.5", v: "7", n: 3 })),
      );
    }) as typeof fetch;
    const rows = await createHyperliquidCandles("https://hl.test/info", fetchImpl).minuteRows("BTC", end - 2 * MINUTE_MS, end + MINUTE_MS, NOW);
    expect(body).toEqual({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: end - 2 * MINUTE_MS, endTime: end + MINUTE_MS - 1 } });
    expect(rows.map(([t]) => t)).toEqual([end - 2 * MINUTE_MS, end - MINUTE_MS]);
    expect(rows[0]!.slice(1, 6)).toEqual([1, 3, 0.5, 2, 7]);
    expect(rows[0]![6]).toBeNaN();
  });
});

describe("candle store", () => {
  it("round-trips day blocks and keeps coverage across restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "candles-"));
    const block = emptyDay();
    applyRows(block, TODAY, rowsBetween(TODAY * DAY_MS, TODAY * DAY_MS + 90 * MINUTE_MS));
    await createCandleStore(root).writeDay("binance", "BTC", TODAY, block, 100);

    const reopened = createCandleStore(root);
    expect((await reopened.coverage("binance", "BTC")).get(TODAY)).toEqual({ synced: 100, filled: 90 });
    expect(Array.from((await reopened.readDay("binance", "BTC", TODAY))!)).toEqual(Array.from(block));
    expect((await stat(join(root, "binance", "BTC", `${TODAY}.f64`))).size).toBe(DAY_BYTES);
    expect(syncedThrough(await reopened.coverage("binance", "BTC"))).toBe(TODAY * DAY_MS + 100 * MINUTE_MS);
    expect(await reopened.readDay("hyperliquid", "BTC", TODAY)).toBeNull();
    expect(syncedThrough(await reopened.coverage("hyperliquid", "BTC"))).toBeNull();
  });

  it("stores funding history", async () => {
    const store = tempStore();
    expect(await store.readFunding("ETH")).toEqual([]);
    await store.writeFunding("ETH", [[1, 0.0001], [2, -0.0002]]);
    expect(await store.readFunding("ETH")).toEqual([[1, 0.0001], [2, -0.0002]]);
  });

  it("reads minute columns across a day boundary", async () => {
    const store = tempStore();
    for (const day of [TODAY - 1, TODAY]) {
      const block = emptyDay();
      applyRows(block, day, rowsBetween(day * DAY_MS, (day + 1) * DAY_MS));
      await store.writeDay("binance", "BTC", day, block, DAY_MINUTES);
    }
    const from = TODAY * DAY_MS - 2 * MINUTE_MS;
    const columns = await readColumns(store, "binance", "BTC", from, from + 4 * MINUTE_MS);
    expect(Array.from(columns.close)).toEqual([0, 1, 2, 3].map((i) => row(from + i * MINUTE_MS)[4]));
    expect(Array.from(columns.takerBuy)).toEqual([1, 1, 1, 1]);
    const empty = await readColumns(store, "hyperliquid", "BTC", from, from + 2 * MINUTE_MS);
    expect(Array.from(empty.open).every(Number.isNaN)).toBe(true);
  });
});

describe("candle sync", () => {
  it("backfills past months from the archive and the current month from REST", async () => {
    const { binance, calls } = fakeBinance();
    const deps = syncDeps({ binance });
    await syncBinanceCoin(deps, "BTC", NOW);

    // 20 days back from 2026-10-14 = 2026-09-24: seven September days, one archive download
    expect(calls.filter(([kind]) => kind === "archive")).toEqual([["archive", "BTC", 2026, 9]]);
    const rest = calls.filter(([kind]) => kind === "rest");
    expect(rest).toHaveLength(14);
    expect(rest[13]).toEqual(["rest", "BTC", TODAY * DAY_MS, TODAY * DAY_MS + 750 * MINUTE_MS]);

    const coverage = await deps.store.coverage("binance", "BTC");
    expect(coverage.size).toBe(21);
    expect(coverage.has(TODAY - 21)).toBe(false);
    expect(coverage.get(TODAY - 20)).toEqual({ synced: DAY_MINUTES, filled: DAY_MINUTES });
    expect(coverage.get(TODAY)).toEqual({ synced: 750, filled: 750 });

    // two minutes later only the new minutes are fetched
    calls.length = 0;
    await syncBinanceCoin(deps, "BTC", NOW + 2 * MINUTE_MS);
    expect(calls).toEqual([["rest", "BTC", TODAY * DAY_MS + 750 * MINUTE_MS, TODAY * DAY_MS + 752 * MINUTE_MS]]);
    expect((await deps.store.coverage("binance", "BTC")).get(TODAY)).toEqual({ synced: 752, filled: 752 });
  });

  it("falls back to REST per day while a month isn't archived", async () => {
    const { binance, calls } = fakeBinance({ archived: false });
    const deps = syncDeps({ binance });
    await syncBinanceCoin(deps, "ETH", NOW);
    expect(calls.filter(([kind]) => kind === "rest")).toHaveLength(21);
    expect((await deps.store.coverage("binance", "ETH")).get(TODAY - 20)).toEqual({ synced: DAY_MINUTES, filled: DAY_MINUTES });
  });

  it("captures what Hyperliquid retains, then continues from the last synced minute", async () => {
    const { hyperliquid, calls } = fakeHyperliquid();
    const deps = syncDeps({ hyperliquid });
    const end = NOW - (NOW % MINUTE_MS);
    await syncHyperliquidCoin(deps, "BTC", NOW);
    expect(calls).toEqual([["hl", "BTC", end - HL_RETAINED_MINUTES * MINUTE_MS, end]]);

    const coverage = await deps.store.coverage("hyperliquid", "BTC");
    const firstDay = dayOf(end - HL_RETAINED_MINUTES * MINUTE_MS);
    expect(coverage.get(firstDay)).toEqual({ synced: DAY_MINUTES, filled: (firstDay + 1) * DAY_MS / MINUTE_MS - (end / MINUTE_MS - HL_RETAINED_MINUTES) });
    expect(coverage.get(TODAY)).toEqual({ synced: 750, filled: 750 });
    expect((await deps.store.readDay("hyperliquid", "BTC", TODAY))![749 * FIELDS + 5]).toBeNaN();

    calls.length = 0;
    await syncHyperliquidCoin(deps, "BTC", NOW + 3 * MINUTE_MS);
    expect(calls).toEqual([["hl", "BTC", end, end + 3 * MINUTE_MS]]);
    expect((await deps.store.coverage("hyperliquid", "BTC")).get(TODAY)).toEqual({ synced: 753, filled: 753 });
  });

  it("tops funding up from the last stored settlement", async () => {
    const { binance, calls } = fakeBinance();
    const deps = syncDeps({ binance });
    await syncFundingCoin(deps, "BTC", NOW);
    const first = await deps.store.readFunding("BTC");
    expect(first[0]![0]).toBeGreaterThanOrEqual((TODAY - 20) * DAY_MS);
    await syncFundingCoin(deps, "BTC", NOW);
    expect(calls).toEqual([
      ["funding", "BTC", (TODAY - 20) * DAY_MS],
      ["funding", "BTC", first[first.length - 1]![0] + 1],
    ]);
    expect(await deps.store.readFunding("BTC")).toEqual(first);
  });

  it("reports a failing coin without stopping the others", async () => {
    const { binance } = fakeBinance();
    const failing: BinanceFutures = { ...binance, minuteRows: async (coin, from, to) => (coin === "ETH" ? Promise.reject(new Error("boom")) : binance.minuteRows(coin, from, to)) };
    const deps = syncDeps({ binance: failing, backfillDays: 0, now: () => NOW });
    const sync = createCandleSync(deps);
    await sync.run("binance");
    expect(sync.status().binance).toMatchObject({ running: false, lastRunAt: NOW, lastOkAt: null, lastError: "ETH: boom" });
    expect((await deps.store.coverage("binance", "BTC")).get(TODAY)).toEqual({ synced: 750, filled: 750 });
  });
});
