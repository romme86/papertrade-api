import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export const bearerAuth = (token: string): MiddlewareHandler => {
  const expected = Buffer.from(token);
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const provided = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return c.json({ error: { code: "unauthorized", message: "Missing or invalid bearer token" } }, 401);
    }
    await next();
  };
};
