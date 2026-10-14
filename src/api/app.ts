import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import type { AppDeps } from "./deps.js";
import { handleError } from "./errors.js";
import { adminRoutes } from "./routes/admin.js";
import { candleRoutes } from "./routes/candles.js";
import { paperRoutes } from "./routes/paper.js";
import { readRoutes } from "./routes/read.js";
import { tradeRoutes } from "./routes/trade.js";

export const createApp = (deps: AppDeps) => {
  const now = deps.now ?? Date.now;
  const app = new Hono();
  app.onError(handleError(deps.logger));

  // Unauthenticated liveness probe; reveals nothing beyond mode and freshness.
  app.get("/health", (c) => {
    const at = deps.stream.lastEventAt();
    const snapshotAgeMs = at === null ? null : now() - at;
    return c.json({ ok: true, mode: deps.config.liveTrading ? "live" : "dry-run", walletSnapshot: deps.stream.state() !== null, snapshotAgeMs });
  });

  const v1 = new Hono();
  v1.use("*", bearerAuth(deps.config.apiToken));
  v1.route("/", readRoutes(deps));
  v1.route("/", tradeRoutes(deps));
  v1.route("/", adminRoutes(deps));
  v1.route("/", paperRoutes(deps));
  v1.route("/", candleRoutes(deps));
  app.route("/v1", v1);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "No such route" } }, 404));
  return app;
};
