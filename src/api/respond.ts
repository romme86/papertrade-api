import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { jsonReplacer } from "../lib/logger.js";

// JSON response that serialises bigint values as decimal strings.
export const json = (c: Context, data: unknown, status: ContentfulStatusCode = 200) =>
  c.body(JSON.stringify(data, jsonReplacer), status, { "Content-Type": "application/json; charset=utf-8" });
