import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import type { MinuteRow } from "./types.js";

const LOCAL_HEADER_BYTES = 30;
const HAS_DATA_DESCRIPTOR = 0x08;
const DEFLATE = 8;

/** Passes on only the compressed bytes of a zip's first entry, as they arrive. */
const firstEntry = () => {
  let head = Buffer.alloc(0);
  let left: number | null = null; // null until the local header has been read
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (left === null) {
        head = Buffer.concat([head, chunk]);
        if (head.length < LOCAL_HEADER_BYTES) return done();
        if (head.readUInt32LE(0) !== 0x04034b50) return done(new Error("Not a zip archive"));
        if (head.readUInt16LE(8) !== DEFLATE) return done(new Error(`Unsupported zip compression ${head.readUInt16LE(8)}`));
        const start = LOCAL_HEADER_BYTES + head.readUInt16LE(26) + head.readUInt16LE(28);
        if (head.length < start) return done();
        // with a data descriptor the size comes after the data; inflate stops at the stream end anyway
        left = head.readUInt16LE(6) & HAS_DATA_DESCRIPTOR ? Infinity : head.readUInt32LE(18);
        chunk = head.subarray(start);
        head = Buffer.alloc(0);
      }
      const take = chunk.subarray(0, Math.min(chunk.length, left));
      left -= take.length;
      done(null, take.length ? take : undefined);
    },
  });
};

/** Kline CSV rows (with or without a header line). */
export const parseKlineCsv = (text: string): MinuteRow[] => {
  const rows: MinuteRow[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(",");
    if (f.length < 10) continue;
    const time = Number(f[0]);
    if (!Number.isFinite(time)) continue;
    rows.push([time, Number(f[1]), Number(f[2]), Number(f[3]), Number(f[4]), Number(f[5]), Number(f[9])]);
  }
  return rows;
};

/**
 * Rows of a zipped kline CSV (Binance's monthly archives hold one), parsed while it
 * downloads: nothing bigger than a network chunk is held, so a month costs a few MB
 * of memory rather than the whole archive, its CSV and every row at once.
 */
export const streamKlineRows = async (zip: AsyncIterable<Uint8Array>, onRows: (rows: MinuteRow[]) => void): Promise<void> => {
  const decoder = new TextDecoder();
  let rest = "";
  await pipeline(zip, firstEntry(), createInflateRaw(), async (csv: AsyncIterable<Buffer>) => {
    for await (const chunk of csv) {
      const text = rest + decoder.decode(chunk, { stream: true });
      const end = text.lastIndexOf("\n");
      rest = text.slice(end + 1);
      if (end >= 0) onRows(parseKlineCsv(text.slice(0, end)));
    }
    if (rest) onRows(parseKlineCsv(rest));
  });
};
