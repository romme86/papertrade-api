import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { silentLogger } from "../src/lib/logger.js";
import { limits, makeHarness, NOW, walletAccount } from "./harness.js";

const TOKEN = "t".repeat(40);

const appFor = (liveTrading: boolean) => {
  const h = makeHarness({ liveTrading });
  const app = createApp({
    config: { apiToken: TOKEN, liveTrading, limits },
    wallet: walletAccount,
    query: h.query,
    stream: h.stream,
    hyperliquid: h.hyperliquid,
    hyperevm: { computeDepositProxy: async () => "0x1111111111111111111111111111111111111111" },
    session: h.session,
    executor: h.executor,
    paper: h.paper,
    store: h.store,
    logger: silentLogger,
    now: () => NOW,
  });
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    app.request(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
    });
  return { h, call };
};

describe("HTTP API", () => {
  it("serves /health without auth", async () => {
    const { call } = appFor(false);
    const res = await call("/health", {}, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "dry-run", walletSnapshot: true });
  });

  it("requires the bearer token on /v1", async () => {
    const { call } = appFor(false);
    expect((await call("/v1/account", {}, null)).status).toBe(401);
    expect((await call("/v1/account", {}, "wrong")).status).toBe(401);
    const res = await call("/v1/account");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ balances: { availableUsd: "500" }, session: { activeKey: expect.any(String) } });
  });

  it("reports the live margin caps and PAPER rewards on /v1/account", async () => {
    const { call } = appFor(false);
    const body = await (await call("/v1/account")).json();
    expect(body).toMatchObject({
      limits: { maxMarginUsd: "100", maxTotalMarginUsd: "300", baseMaxMarginUsd: "100", realizedProfitUsd: "0" },
      paper: { balance: "0", staked: "0", claimableUsd: "0", rewardsClaimedUsd: "0", minimumStake: "1000" },
    });
  });

  it("refuses a live stake below Papertrade's minimum with 422", async () => {
    const { call, h } = appFor(true);
    const res = await call("/v1/paper/stake", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { violations: { code: string }[] } };
    expect(body.error.violations.map((v) => v.code)).toContain("amount_invalid");
    expect(h.calls).toEqual([]);
  });

  it("lists markets with live params and HL prices", async () => {
    const { call } = appFor(false);
    const body = (await (await call("/v1/markets")).json()) as { markets: { market: string; minimumNotionalUsd: string; price: { mid: number } }[] };
    expect(body.markets.map((m) => m.market)).toEqual(["BTC", "ETH"]);
    expect(body.markets[0]).toMatchObject({ minimumNotionalUsd: "10000", price: { mid: 83_139.5 } });
  });

  it("returns 422 with violations when a live open breaks a guard", async () => {
    const { call, h } = appFor(true);
    const res = await call("/v1/orders/open", { method: "POST", body: JSON.stringify({ market: "BTC", side: "long", marginUsd: "500", leverage: 20 }) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { violations: { code: string }[] } };
    expect(body.error.violations.map((v) => v.code)).toContain("limit_margin");
    expect(h.calls).toEqual([]);
  });

  it("returns 202 for an accepted live open", async () => {
    const { call } = appFor(true);
    const res = await call("/v1/orders/open", { method: "POST", body: JSON.stringify({ market: "BTC", side: "long", marginUsd: "100", leverage: 100 }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ mode: "live", submission: { state: "queued" } });
  });

  it("validates request bodies", async () => {
    const { call } = appFor(false);
    const res = await call("/v1/orders/open", { method: "POST", body: JSON.stringify({ market: "DOGE", side: "up" }) });
    expect(res.status).toBe(400);
  });

  it("toggles the kill switch", async () => {
    const { call } = appFor(false);
    const res = await call("/v1/kill-switch", { method: "POST", body: JSON.stringify({ engaged: true, reason: "manual" }) });
    expect(await res.json()).toMatchObject({ engaged: true, reason: "manual" });
  });

  it("returns the deposit address cross-checked on-chain", async () => {
    const { call } = appFor(false);
    expect(await (await call("/v1/funding/deposit-address")).json()).toMatchObject({ matchesRelayer: true });
  });
});
