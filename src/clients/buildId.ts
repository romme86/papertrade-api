import { get as httpsGet } from "node:https";
import type { Logger } from "../lib/logger.js";

// The frontend tags every request with X-Papertrade-Build. We discover the
// current build id from the live bundle so a frontend redeploy doesn't
// silently strand us on a stale id. The header is best-effort: null means
// "send without it".
export type BuildIdProvider = {
  get: () => Promise<string | null>;
  refresh: () => Promise<string | null>;
};

type Options = {
  origin: string;
  fallback: string | undefined;
  ttlMs?: number;
  fetchText?: (url: string) => Promise<string>;
  logger: Logger;
};

const ASSET_PATTERN = /(?:assets\/|\.\/)([A-Za-z0-9_\-.]+\.js)/g;
const BUILD_CHUNK = /^build-[A-Za-z0-9_-]+\.js$/;
const BUILD_VALUE = /`([0-9a-f]{8,64})`/;
const MAX_CHUNKS = 60;

// Plain node:https on purpose: undici's fetch always sends
// "Sec-Fetch-Mode: cors", and the exchange only serves its SPA shell to
// requests that don't look like CORS fetches.
export const httpsText = (url: string, redirects = 3): Promise<string> =>
  new Promise((resolve, reject) => {
    const request = httpsGet(url, { headers: { Accept: url.endsWith(".js") ? "*/*" : "text/html" }, timeout: 10_000 }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume();
        resolve(httpsText(new URL(response.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`GET ${url} returned ${status}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve(body));
    });
    request.on("timeout", () => request.destroy(new Error(`GET ${url} timed out`)));
    request.on("error", reject);
  });

export const createBuildIdProvider = ({ origin, fallback, ttlMs = 30 * 60_000, fetchText = httpsText, logger }: Options): BuildIdProvider => {
  let cached: { value: string | null; at: number } | null = null;

  const discover = async (): Promise<string> => {
    const html = await fetchText(`${origin}/`);
    const queue = [...html.matchAll(ASSET_PATTERN)].map((m) => m[1]!);
    const seen = new Set<string>();
    while (queue.length && seen.size < MAX_CHUNKS) {
      const buildChunk = queue.find((name) => BUILD_CHUNK.test(name));
      if (buildChunk) {
        const match = (await fetchText(`${origin}/assets/${buildChunk}`)).match(BUILD_VALUE);
        if (match?.[1]) return match[1];
        throw new Error(`Build chunk ${buildChunk} has no build id`);
      }
      const chunk = queue.shift()!;
      if (seen.has(chunk)) continue;
      seen.add(chunk);
      const source = await fetchText(`${origin}/assets/${chunk}`);
      for (const m of source.matchAll(ASSET_PATTERN)) if (!seen.has(m[1]!)) queue.push(m[1]!);
    }
    throw new Error("Build id chunk not found in frontend bundle");
  };

  const refresh = async (): Promise<string | null> => {
    try {
      const value = await discover();
      if (cached?.value !== value) logger.info("papertrade build id", { buildId: value });
      cached = { value, at: Date.now() };
    } catch (error) {
      const value = cached?.value ?? fallback ?? null;
      logger.warn("build id discovery failed", { error, using: value });
      // Back off a few minutes before trying discovery again.
      cached = { value, at: Date.now() - ttlMs + 5 * 60_000 };
    }
    return cached.value;
  };

  return {
    get: async () => (cached && Date.now() - cached.at < ttlMs ? cached.value : refresh()),
    refresh,
  };
};
