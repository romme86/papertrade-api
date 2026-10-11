import { Hono } from "hono";
import { z } from "zod";
import { json } from "../respond.js";
import { parseUsd, rawToNumber } from "../../lib/units.js";
import { MARKETS, marketSymbols, type MarketSymbol } from "../../protocol/deployment.js";
import { instrumentFor } from "../../trading/markets.js";
import { buildQuote, impactParams } from "../../trading/quote.js";
import type { AppDeps } from "../deps.js";

const Market = z.enum(marketSymbols as [MarketSymbol, ...MarketSymbol[]]);
const Usd = z.union([z.string(), z.number().positive()]);
const PositionId = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));

const QuoteBody = z.object({
  market: Market,
  side: z.enum(["long", "short"]),
  marginUsd: Usd,
  leverage: z.number().int().positive(),
  entryPrice: z.number().positive().optional(),
  exitPrice: z.number().positive().optional(),
});

const OpenBody = z.object({
  market: Market,
  side: z.enum(["long", "short"]),
  marginUsd: Usd,
  leverage: z.number().int().positive(),
  dryRun: z.boolean().optional(),
});

const CloseBody = z.object({
  positionIds: z.array(PositionId).min(1).max(120),
  dryRun: z.boolean().optional(),
});

const DryRunBody = z.object({ dryRun: z.boolean().optional() }).default({});

const readJson = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

export const tradeRoutes = (deps: AppDeps) => {
  const app = new Hono();

  app.post("/quote", async (c) => {
    const body = QuoteBody.parse(await readJson(c));
    const trading = await deps.query.tradingState();
    const instrument = instrumentFor(trading, body.market);
    const entryPrice = body.entryPrice ?? (await deps.hyperliquid.bbo(MARKETS[body.market].hlCoin)).mid;
    const quote = buildQuote(
      { isLong: body.side === "long", marginUsd: rawToNumber(parseUsd(body.marginUsd)), leverage: body.leverage, entryPrice, exitPrice: body.exitPrice },
      impactParams(instrument),
    );
    return json(c, quote);
  });

  app.post("/orders/open", async (c) => {
    const body = OpenBody.parse(await readJson(c));
    const result = await deps.executor.open(body);
    return json(c, result, result.mode === "live" ? 202 : 200);
  });

  app.post("/orders/close", async (c) => {
    const body = CloseBody.parse(await readJson(c));
    const result = await deps.executor.close(body.positionIds, { dryRun: body.dryRun });
    return json(c, result, result.mode === "live" ? 202 : 200);
  });

  app.post("/orders/close-all", async (c) => {
    const body = DryRunBody.parse(await readJson(c));
    const result = await deps.executor.closeAll({ dryRun: body.dryRun });
    return json(c, result, result.mode === "live" ? 202 : 200);
  });

  app.post("/intents/:intentId/cancel", async (c) => {
    const intentId = z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(c.req.param("intentId")).toLowerCase() as `0x${string}`;
    const body = DryRunBody.parse(await readJson(c));
    return json(c, await deps.executor.cancel(intentId, { dryRun: body.dryRun }));
  });

  return app;
};
