import { Hono } from "hono";
import { z } from "zod";
import type { Bbo } from "../../clients/hyperliquid.js";
import { json } from "../respond.js";
import { MARKETS, marketSymbols, type MarketSymbol } from "../../protocol/deployment.js";
import { HistoryKindSchema } from "../../protocol/schemas.js";
import { instrumentFor } from "../../trading/markets.js";
import type { AppDeps } from "../deps.js";
import { NotReadyError } from "../errors.js";
import { accountView, instrumentView, positionView } from "../views.js";

const HistoryQuery = z.object({ cursor: z.string().min(1).max(2048).optional() });

export const readRoutes = (deps: AppDeps) => {
  const now = deps.now ?? Date.now;
  const app = new Hono();

  const bbos = async (): Promise<Partial<Record<MarketSymbol, Bbo>>> => {
    const entries = await Promise.all(
      marketSymbols.map(async (market) => [market, await deps.hyperliquid.bbo(MARKETS[market].hlCoin).catch(() => null)] as const),
    );
    return Object.fromEntries(entries.filter(([, bbo]) => bbo !== null));
  };

  const walletOrThrow = () => {
    const state = deps.stream.state();
    if (!state) throw new NotReadyError("Wallet snapshot not received from Papertrade yet");
    return state;
  };

  const snapshotAge = () => {
    const at = deps.stream.lastEventAt();
    return at === null ? null : now() - at;
  };

  app.get("/markets", async (c) => {
    const [trading, prices] = await Promise.all([deps.query.tradingState(), bbos()]);
    return json(c, {
      tradingPaused: trading.tradingPaused,
      pausedActions: trading.intake.pausedActions,
      markets: marketSymbols.map((market) => instrumentView(instrumentFor(trading, market), trading, prices[market] ?? null)),
    });
  });

  app.get("/account", (c) => json(c, accountView(walletOrThrow(), deps.session.status(), snapshotAge())));

  app.get("/positions", async (c) => {
    const state = walletOrThrow();
    const [trading, prices] = await Promise.all([deps.query.tradingState(), bbos()]);
    return json(c, { snapshotAgeMs: snapshotAge(), positions: state.openPositions.map((p) => positionView(p, trading, prices)) });
  });

  app.get("/positions/closed", (c) => json(c, { recent: deps.stream.outcomes.recentClosed() }));

  app.get("/history/:kind", async (c) => {
    const kind = HistoryKindSchema.parse(c.req.param("kind"));
    const options = HistoryQuery.parse(c.req.query());
    return json(c, await deps.query.history(deps.wallet.address, kind, options));
  });

  app.get("/intents/:intentId", (c) => {
    const intentId = z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(c.req.param("intentId")).toLowerCase() as `0x${string}`;
    const pending = deps.stream.state()?.operations.find((op) => op.intentId === intentId) ?? null;
    const outcome = deps.stream.outcomes.intent(intentId) ?? null;
    const status = outcome?.outcome ?? (pending ? "queued" : "unknown");
    return json(c, { intentId, status, pending, outcome });
  });

  app.get("/protocol", async (c) => {
    const [summary, queue, relayer, notices] = await Promise.all([
      deps.query.protocolSummary(),
      deps.query.queueSummary(),
      deps.query.relayerHealth().catch((error: Error) => ({ error: error.message })),
      deps.query.notices(),
    ]);
    return json(c, { summary, queue, relayer, notices });
  });

  return app;
};
