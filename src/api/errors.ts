import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { PapertradeHttpError } from "../clients/http.js";
import type { Logger } from "../lib/logger.js";
import { UnitError } from "../lib/units.js";
import { GuardError } from "../trading/executor.js";
import { MarketError } from "../trading/markets.js";

export class NotReadyError extends Error {}

const body = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, ...extra } });

export const handleError = (logger: Logger) => (error: Error, c: Context) => {
  if (error instanceof ZodError) return c.json(body("invalid_request", "Request validation failed", { issues: error.issues }), 400);
  if (error instanceof UnitError || error instanceof MarketError) return c.json(body("invalid_request", error.message), 400);
  if (error instanceof GuardError) return c.json(body("guard_rejected", error.message, { violations: error.violations }), 422);
  if (error instanceof NotReadyError) return c.json(body("not_ready", error.message), 503);
  if (error instanceof PapertradeHttpError) {
    const status = (error.status === 429 ? 429 : 502) as ContentfulStatusCode;
    if (error.retryAfterMs) c.header("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
    logger.warn("papertrade upstream error", { status: error.status, code: error.code, message: error.message });
    return c.json(body("upstream_error", error.message, { upstreamStatus: error.status, upstreamCode: error.code, upstream: error.payload }), status);
  }
  logger.error("unhandled error", { error: error.stack ?? error.message });
  return c.json(body("internal_error", "Internal error"), 500);
};
