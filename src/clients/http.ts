import type { BuildIdProvider } from "./buildId.js";

export class PapertradeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly payload: unknown,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "PapertradeHttpError";
  }
}

export type PapertradeHttp = {
  get: (path: string, options?: { timeoutMs?: number }) => Promise<unknown>;
  post: (path: string, body: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

type Options = {
  origin: string;
  buildId: BuildIdProvider;
  userAgent: string;
  fetchImpl?: typeof fetch;
};

const STALE_BUILD = /build|outdated|client.?version/i;

export const createPapertradeHttp = ({ origin, buildId, userAgent, fetchImpl = fetch }: Options): PapertradeHttp => {
  // The relayer posts with credentials: "include"; keep any cookies it sets.
  const cookies = new Map<string, string>();

  const request = async (method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, retried: boolean): Promise<unknown> => {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": userAgent };
    const build = await buildId.get();
    if (build) headers["X-Papertrade-Build"] = build;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

    const response = await fetchImpl(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const index = pair?.indexOf("=") ?? -1;
      if (pair && index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }

    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    const record = (payload ?? {}) as Record<string, unknown>;
    if (response.ok && !record.error && record.ok !== false) return payload;

    const code = String(record.code ?? record.error ?? `http_${response.status}`);
    const message = String(record.message ?? record.error ?? `${method} ${path} failed with ${response.status}`);
    if (!retried && response.status < 500 && STALE_BUILD.test(`${code} ${message}`)) {
      await buildId.refresh();
      return request(method, path, body, timeoutMs, true);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new PapertradeHttpError(message, response.status, code, payload, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
  };

  return {
    get: (path, options) => request("GET", path, undefined, options?.timeoutMs ?? 15_000, false),
    post: (path, body, options) => request("POST", path, body, options?.timeoutMs ?? 15_000, false),
  };
};
