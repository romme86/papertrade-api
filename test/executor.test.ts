import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress, concat, type Hex } from "viem";
import { GuardError } from "../src/trading/executor.js";
import { INTENT_TYPES } from "../src/protocol/typedData.js";
import { fundedWallet, makeHarness, sessionAccount, walletAccount, NOW } from "./harness.js";
import { usd } from "./fixtures.js";

const signatureOf = (body: Record<string, unknown>) => concat([body.r as Hex, body.s as Hex, `0x${Number(body.v).toString(16)}`]);

const position = (id: string) => [id, 0, true, false, "831395", usd(10), 1000, "830000", NOW - 60_000, null];

describe("open", () => {
  it("dry-runs by default without touching the relayer or nonces", async () => {
    const h = makeHarness({ liveTrading: false });
    const result = await h.executor.open({ market: "BTC", side: "long", marginUsd: "100", leverage: 100 });
    expect(result.mode).toBe("dry-run");
    expect(result.violations).toEqual([]);
    expect(result.submission).toBeNull();
    expect(result.message).not.toHaveProperty("r");
    expect(result.message).toMatchObject({ instrumentId: "0", isLong: true, size: usd(100), leverage: "100", useDebt: false });
    expect(result.quote.notionalUsd).toBe(10_000);
    expect(h.calls).toEqual([]);
    expect(h.store.read().nonces).toEqual({});
  });

  it("reports guard violations in dry-run instead of throwing", async () => {
    const h = makeHarness({ liveTrading: false });
    const result = await h.executor.open({ market: "ETH", side: "short", marginUsd: 20, leverage: 100 });
    expect(result.violations.map((v) => v.code)).toContain("notional_below_min");
  });

  it("submits a session-key-signed OpenPosition when live", async () => {
    const h = makeHarness({ liveTrading: true });
    const result = await h.executor.open({ market: "BTC", side: "short", marginUsd: "100", leverage: 100 });
    expect(result.mode).toBe("live");
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call?.action).toBe("openPosition");
    expect(call?.body).toMatchObject({ user: walletAccount.address.toLowerCase(), isLong: false, size: usd(100), leverage: "100" });

    const body = call!.body;
    const signer = await recoverTypedDataAddress({
      domain: h.exchange,
      types: { OpenPosition: INTENT_TYPES.OpenPosition },
      primaryType: "OpenPosition",
      message: {
        user: body.user as Hex,
        instrumentId: Number(body.instrumentId),
        isLong: body.isLong as boolean,
        size: BigInt(body.size as string),
        leverage: Number(body.leverage),
        useDebt: body.useDebt as boolean,
        nonce: BigInt(body.nonce as string),
        deadline: BigInt(body.deadline as string),
      },
      signature: signatureOf(body),
    });
    expect(signer).toBe(sessionAccount.address);
    expect(result.submission?.intentId).toBe(result.submission?.localIntentId);
    expect(Object.keys(h.store.read().nonces)).toHaveLength(1);
    expect(h.auditSink.map((e) => e.event)).toEqual(["submit", "accepted"]);
  });

  it("honours a per-request dryRun even when live", async () => {
    const h = makeHarness({ liveTrading: true });
    expect((await h.executor.open({ market: "BTC", side: "long", marginUsd: 100, leverage: 100, dryRun: true })).mode).toBe("dry-run");
    expect(h.calls).toEqual([]);
  });

  it("refuses live opens that break a guard, before signing", async () => {
    const h = makeHarness({ liveTrading: true });
    await expect(h.executor.open({ market: "BTC", side: "long", marginUsd: 100, leverage: 150 })).rejects.toBeInstanceOf(GuardError);
    expect(h.calls).toEqual([]);
    expect(h.store.read().nonces).toEqual({});
  });

  it("refuses live opens without a registered session key", async () => {
    const h = makeHarness({ liveTrading: true, wallet: fundedWallet({ sessionKeys: [] }) });
    await expect(h.executor.open({ market: "BTC", side: "long", marginUsd: 100, leverage: 100 })).rejects.toThrow(/session key/);
  });
});

describe("close", () => {
  it("batches closes 12 at a time", async () => {
    const ids = Array.from({ length: 13 }, (_, i) => String(i + 1));
    const h = makeHarness({ liveTrading: true, wallet: fundedWallet({ openPositions: ids.map(position) }) });
    const result = await h.executor.close(ids.map(BigInt));
    expect(result.batches.map((b) => b.positionIds.length)).toEqual([12, 1]);
    expect(h.calls.map((c) => c.action)).toEqual(["closePositions", "closePositions"]);
    expect(h.calls[1]?.body.positionIds).toEqual(["13"]);
  });

  it("rejects ids that are not open on this wallet", async () => {
    const h = makeHarness({ liveTrading: true, wallet: fundedWallet({ openPositions: [position("1")] }) });
    await expect(h.executor.close([1n, 99n])).rejects.toBeInstanceOf(GuardError);
    expect(h.calls).toEqual([]);
  });

  it("close-all skips positions that already have a pending close", async () => {
    const h = makeHarness({
      liveTrading: true,
      wallet: fundedWallet({
        openPositions: [position("1"), position("2")],
        operations: [[`0x${"dd".repeat(32)}`, "closePositions", null, null, null, null, null, NOW, "1", ["1"]]],
      }),
    });
    await h.executor.closeAll();
    expect(h.calls.map((c) => c.body.positionIds)).toEqual([["2"]]);
  });

  it("is allowed while the kill switch is engaged", async () => {
    const h = makeHarness({ liveTrading: true, wallet: fundedWallet({ openPositions: [position("1")] }) });
    await h.store.update((s) => ({ ...s, killSwitch: { engaged: true, reason: "test", changedAtMs: NOW } }));
    await h.executor.close([1n]);
    expect(h.calls).toHaveLength(1);
  });
});

describe("cancel", () => {
  it("posts the signed cancel without the intent id in the body", async () => {
    const h = makeHarness({ liveTrading: true });
    const intentId = `0x${"ef".repeat(32)}` as Hex;
    await h.executor.cancel(intentId);
    expect(h.calls[0]).toMatchObject({ kind: "cancel", intentId });
    expect(h.calls[0]?.body).not.toHaveProperty("intentId");
    expect(h.calls[0]?.body).toHaveProperty("v");
  });
});

describe("session registration", () => {
  it("signs RegisterSessionKey with the wallet and keeps the key pending until listed", async () => {
    const h = makeHarness({ liveTrading: true, wallet: fundedWallet({ sessionKeys: [] }), storedSession: false });
    const { key } = await h.session.register();
    const [call] = h.calls;
    expect(call?.action).toBe("registerSessionKey");
    expect(call?.body).toMatchObject({ user: walletAccount.address.toLowerCase(), key: key.toLowerCase(), feeAddress: "0x0000000000000000000000000000000000000000" });
    expect(Number(call?.body.expiry)).toBe(Math.floor((NOW + 2_592_000_000) / 1000));

    const signer = await recoverTypedDataAddress({
      domain: h.exchange,
      types: { RegisterSessionKey: INTENT_TYPES.RegisterSessionKey },
      primaryType: "RegisterSessionKey",
      message: {
        user: call!.body.user as Hex,
        key: call!.body.key as Hex,
        expiry: BigInt(call!.body.expiry as string),
        feeAddress: call!.body.feeAddress as Hex,
        nonce: BigInt(call!.body.nonce as string),
        deadline: BigInt(call!.body.deadline as string),
      },
      signature: signatureOf(call!.body),
    });
    expect(signer).toBe(walletAccount.address);
    expect(h.session.status()).toMatchObject({ activeKey: null, pendingKeys: [key] });

    h.setWallet(fundedWallet({ sessionKeys: [[key.toLowerCase(), call!.body.expiry]] }));
    expect(h.session.status().activeKey).toBe(key);
    expect(h.session.activeSigner()?.address).toBe(key);
  });

  it("renews only when the active key is close to expiry", async () => {
    const h = makeHarness({ liveTrading: true });
    await h.session.maybeRenew();
    expect(h.calls).toEqual([]);

    const nearExpiry = makeHarness({
      liveTrading: true,
      wallet: fundedWallet({ sessionKeys: [[sessionAccount.address.toLowerCase(), String(Math.floor(NOW / 1000) + 3_600 * 24)]] }),
    });
    await nearExpiry.session.maybeRenew();
    expect(nearExpiry.calls.map((c) => c.action)).toEqual(["registerSessionKey"]);
  });
});
