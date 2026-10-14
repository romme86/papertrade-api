import { streamKlineRows } from "./archive.js";
import { addToBlocks } from "./dayBlock.js";
import { MINUTE_MS, type CandleCoin, type FundingPoint, type MinuteRow } from "./types.js";

export const BINANCE_SYMBOL: Record<CandleCoin, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT" };

const KLINE_LIMIT = 1_500;
const FUNDING_LIMIT = 1_000;
const MAX_ATTEMPTS = 5;

export type BinanceFutures = {
  /** Closed 1-minute perp candles with open time in [from, to). */
  minuteRows: (coin: CandleCoin, from: number, to: number) => Promise<MinuteRow[]>;
  /** One month of minutes from Binance's public archive as day blocks, or null while it is unpublished. */
  archiveMonth: (coin: CandleCoin, year: number, month: number) => Promise<Map<number, Float64Array> | null>;
  /** Funding settlements from `from` on. */
  funding: (coin: CandleCoin, from: number) => Promise<FundingPoint[]>;
};

type Options = {
  restUrl: string;
  archiveUrl: string;
  fetchImpl?: typeof fetch;
  /** Pause between REST pages, to stay well inside Binance's weight limits. */
  paceMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const createBinanceFutures = ({ restUrl, archiveUrl, fetchImpl = fetch, paceMs = 300 }: Options): BinanceFutures => {
  const getJson = async (path: string): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(`${restUrl}${path}`, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status === 418 || response.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw new Error(`Binance ${path.split("?")[0]} returned ${response.status}`);
      await sleep(Number(response.headers.get("retry-after") ?? 0) * 1000 || 5_000 * attempt);
    }
  };

  return {
    minuteRows: async (coin, from, to) => {
      const rows: MinuteRow[] = [];
      for (let cursor = from; cursor < to; ) {
        const end = Math.min(to, cursor + KLINE_LIMIT * MINUTE_MS) - 1;
        const page = await getJson(`/klines?symbol=${BINANCE_SYMBOL[coin]}&interval=1m&startTime=${cursor}&endTime=${end}&limit=${KLINE_LIMIT}`);
        if (!Array.isArray(page)) throw new Error("Invalid Binance kline page");
        for (const k of page) {
          if (!Array.isArray(k) || k.length < 10) throw new Error("Invalid Binance kline");
          rows.push([Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5]), Number(k[9])]);
        }
        cursor = end + 1;
        if (paceMs > 0) await sleep(paceMs);
      }
      return rows;
    },

    archiveMonth: async (coin, year, month) => {
      const symbol = BINANCE_SYMBOL[coin];
      const mm = String(month).padStart(2, "0");
      const response = await fetchImpl(`${archiveUrl}/${symbol}/1m/${symbol}-1m-${year}-${mm}.zip`, { signal: AbortSignal.timeout(120_000) });
      if (response.status === 404 || response.status === 403) return null;
      if (!response.ok || !response.body) throw new Error(`Binance archive ${symbol} ${year}-${mm} returned ${response.status}`);
      const blocks = new Map<number, Float64Array>();
      await streamKlineRows(response.body, (rows) => addToBlocks(blocks, rows));
      return blocks;
    },

    funding: async (coin, from) => {
      const points: FundingPoint[] = [];
      for (let cursor = from; ; ) {
        const rows = await getJson(`/fundingRate?symbol=${BINANCE_SYMBOL[coin]}&startTime=${cursor}&limit=${FUNDING_LIMIT}`);
        if (!Array.isArray(rows)) throw new Error("Invalid Binance funding page");
        for (const r of rows as { fundingTime: number; fundingRate: string }[]) points.push([Number(r.fundingTime), Number(r.fundingRate)]);
        if (rows.length < FUNDING_LIMIT) return points;
        cursor = points[points.length - 1]![0] + 1;
        if (paceMs > 0) await sleep(paceMs);
      }
    },
  };
};
