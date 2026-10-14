import { Hono } from "hono";
import { z } from "zod";
import { json } from "../respond.js";
import type { AppDeps } from "../deps.js";
import { NotReadyError } from "../errors.js";
import { paperView } from "../views.js";

// A PAPER amount with up to 18 decimals, or "all".
const Amount = z.union([z.literal("all"), z.string().regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/)]);
const AmountBody = z.object({ amount: Amount.default("all"), dryRun: z.boolean().optional() });
const DryRunBody = z.object({ dryRun: z.boolean().optional() });

const readJson = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

export const paperRoutes = (deps: AppDeps) => {
  const app = new Hono();

  app.get("/paper", async (c) => {
    const state = deps.stream.state();
    if (!state) throw new NotReadyError("Wallet snapshot not received from Papertrade yet");
    return json(c, paperView(state, await deps.query.tradingState().catch(() => null)));
  });

  app.post("/paper/stake", async (c) => {
    const body = AmountBody.parse(await readJson(c));
    const result = await deps.paper.stake(body.amount, { dryRun: body.dryRun });
    return json(c, result, result.mode === "live" ? 202 : 200);
  });

  app.post("/paper/unstake", async (c) => {
    const body = AmountBody.parse(await readJson(c));
    const result = await deps.paper.unstake(body.amount, { dryRun: body.dryRun });
    return json(c, result, result.mode === "live" ? 202 : 200);
  });

  app.post("/paper/claim", async (c) => {
    const body = DryRunBody.parse(await readJson(c));
    const result = await deps.paper.claim({ dryRun: body.dryRun });
    return json(c, result, result.mode === "live" ? 202 : 200);
  });

  return app;
};
