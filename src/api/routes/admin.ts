import { Hono } from "hono";
import { z } from "zod";
import { json } from "../respond.js";
import type { AppDeps } from "../deps.js";

const KillSwitchBody = z.object({ engaged: z.boolean(), reason: z.string().max(200).optional() });

export const adminRoutes = (deps: AppDeps) => {
  const now = deps.now ?? Date.now;
  const app = new Hono();

  app.get("/session", (c) => json(c, { wallet: deps.wallet.address, ...deps.session.status() }));

  // Registration is not a trade, but it is a signed write to Papertrade on
  // the wallet's behalf, so it only runs when explicitly requested here or
  // by the auto-renew loop in live mode.
  app.post("/session/register", async (c) => json(c, await deps.session.register(), 202));

  app.get("/kill-switch", (c) => json(c, deps.store.read().killSwitch));

  app.post("/kill-switch", async (c) => {
    const body = KillSwitchBody.parse(await c.req.json().catch(() => ({})));
    const next = await deps.store.update((state) => ({
      ...state,
      killSwitch: { engaged: body.engaged, reason: body.reason ?? null, changedAtMs: now() },
    }));
    deps.logger.warn("kill switch changed", next.killSwitch);
    return json(c, next.killSwitch);
  });

  // Where to send USDC on Hyperliquid to fund this wallet. Cross-checked
  // against the factory's on-chain CREATE2 derivation.
  app.get("/funding/deposit-address", async (c) => {
    const [fromRelayer, fromChain] = await Promise.all([
      deps.query.depositAddress(deps.wallet.address),
      deps.hyperevm.computeDepositProxy(deps.wallet.address),
    ]);
    return json(c, {
      wallet: deps.wallet.address,
      depositAddress: fromChain,
      matchesRelayer: fromRelayer === fromChain,
      relayerAddress: fromRelayer,
      notes: [
        "Send USDC on Hyperliquid (HyperCore) to depositAddress; at least 10 USDC must arrive.",
        "First deposit pays a one-time 1 USDC activation fee.",
        "Send one deposit at a time and wait for it to be credited.",
      ],
    });
  });

  return app;
};
