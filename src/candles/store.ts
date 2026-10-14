import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createMutex, type Mutex } from "../lib/mutex.js";
import { filledMinutes } from "./dayBlock.js";
import { DAY_BYTES, DAY_MS, MINUTE_MS, type CandleCoin, type CandleSource, type FundingPoint } from "./types.js";

/** synced = minutes of the day already fetched (from midnight); filled = minutes that have a candle. */
export type DayCoverage = { synced: number; filled: number };
export type Coverage = ReadonlyMap<number, DayCoverage>;

export type CandleStore = {
  coverage: (source: CandleSource, coin: CandleCoin) => Promise<Coverage>;
  readDay: (source: CandleSource, coin: CandleCoin, day: number) => Promise<Float64Array | null>;
  writeDay: (source: CandleSource, coin: CandleCoin, day: number, block: Float64Array, synced: number) => Promise<void>;
  readFunding: (coin: CandleCoin) => Promise<FundingPoint[]>;
  writeFunding: (coin: CandleCoin, points: FundingPoint[]) => Promise<void>;
};

/** End of what has been fetched: the open time of the first minute still to sync, or null when nothing is stored. */
export const syncedThrough = (coverage: Coverage): number | null => {
  let through: number | null = null;
  for (const [day, { synced }] of coverage) through = Math.max(through ?? 0, day * DAY_MS + synced * MINUTE_MS);
  return through;
};

type IndexFile = { version: 1; days: Record<string, [synced: number, filled: number]> };

const writeAtomic = async (path: string, data: string | Uint8Array) => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
};

const readOrNull = async (path: string): Promise<Buffer | null> => {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

// <root>/<source>/<coin>/<day>.f64 holds one raw day block (the same bytes as
// Cassandrina's browser store); index.json next to it records each day's
// coverage so a restart doesn't have to read every block.
export const createCandleStore = (root: string): CandleStore => {
  const indexes = new Map<string, Promise<Map<number, DayCoverage>>>();
  const locks = new Map<string, Mutex>();
  const dir = (source: CandleSource, coin: CandleCoin) => join(root, source, coin);
  const keyOf = (source: CandleSource, coin: CandleCoin) => `${source}/${coin}`;

  const lockFor = (key: string) => {
    let lock = locks.get(key);
    if (!lock) locks.set(key, (lock = createMutex()));
    return lock;
  };

  const loadIndex = (source: CandleSource, coin: CandleCoin) => {
    const key = keyOf(source, coin);
    let index = indexes.get(key);
    if (!index) {
      index = readOrNull(join(dir(source, coin), "index.json")).then((buffer) => {
        const parsed = buffer ? (JSON.parse(buffer.toString("utf8")) as IndexFile) : null;
        return new Map(Object.entries(parsed?.days ?? {}).map(([day, [synced, filled]]) => [Number(day), { synced, filled }]));
      });
      index.catch(() => indexes.delete(key));
      indexes.set(key, index);
    }
    return index;
  };

  return {
    coverage: (source, coin) => loadIndex(source, coin),

    readDay: async (source, coin, day) => {
      const buffer = await readOrNull(join(dir(source, coin), `${day}.f64`));
      if (!buffer || buffer.byteLength !== DAY_BYTES) return null;
      return new Float64Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    },

    writeDay: (source, coin, day, block, synced) =>
      lockFor(keyOf(source, coin))(async () => {
        const index = await loadIndex(source, coin);
        await writeAtomic(join(dir(source, coin), `${day}.f64`), new Uint8Array(block.buffer, block.byteOffset, block.byteLength));
        index.set(day, { synced, filled: filledMinutes(block) });
        const days: IndexFile["days"] = {};
        for (const [d, c] of [...index].sort(([a], [b]) => a - b)) days[d] = [c.synced, c.filled];
        await writeAtomic(join(dir(source, coin), "index.json"), JSON.stringify({ version: 1, days } satisfies IndexFile));
      }),

    readFunding: async (coin) => {
      const buffer = await readOrNull(join(dir("binance", coin), "funding.json"));
      return buffer ? (JSON.parse(buffer.toString("utf8")) as FundingPoint[]) : [];
    },

    writeFunding: (coin, points) => lockFor(`funding/${coin}`)(() => writeAtomic(join(dir("binance", coin), "funding.json"), JSON.stringify(points))),
  };
};
