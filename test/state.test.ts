import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatUsd, parseUsd, UnitError } from "../src/lib/units.js";
import { createNonceAllocator, randomNonceStart } from "../src/state/nonces.js";
import { createMemoryStateStore, openStateStore } from "../src/state/store.js";
import { realizedTodayRaw } from "../src/trading/dailyLoss.js";

const exchange = "0x6cd5661646289fb6e65ea5c032310fded797d0a2" as const;
const user = "0x000000000000000000000000000000000000dEaD" as const;

describe("units", () => {
  it("parses and formats 18-decimal USD amounts", () => {
    expect(parseUsd("10")).toBe(10n * 10n ** 18n);
    expect(parseUsd(12.5)).toBe(125n * 10n ** 17n);
    expect(formatUsd(parseUsd("1234.5678"), 2)).toBe("1234.56");
    expect(formatUsd(-parseUsd("3.25"))).toBe("-3.25");
  });

  it("rejects malformed amounts", () => {
    expect(() => parseUsd("-1")).toThrow(UnitError);
    expect(() => parseUsd("1e3")).toThrow(UnitError);
    expect(() => parseUsd("0.1234567890123456789")).toThrow(UnitError);
  });
});

describe("nonces", () => {
  it("starts at a random multiple of 256 and counts up per lane", async () => {
    const store = createMemoryStateStore();
    const nonces = createNonceAllocator(store, 999, exchange, user);
    const first = await nonces.take("session");
    expect(first % 256n).toBe(0n);
    expect(await nonces.take("session")).toBe(first + 1n);
    const paper = await nonces.take("paper");
    expect(await nonces.take("paper")).toBe(paper + 1n);
  });

  it("keys lanes like the frontend so state survives restarts", async () => {
    const store = createMemoryStateStore();
    await createNonceAllocator(store, 999, exchange, user).take("session");
    expect(Object.keys(store.read().nonces)).toEqual([`papertrade.clientNonce.v1:999:${exchange}:session:${user.toLowerCase()}`]);
  });

  it("never returns zero", () => {
    for (let i = 0; i < 50; i++) expect(randomNonceStart() > 0n).toBe(true);
  });
});

describe("state store", () => {
  it("persists atomically with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "papertrade-state-"));
    const store = await openStateStore(dir);
    await store.update((s) => ({ ...s, killSwitch: { engaged: true, reason: "test", changedAtMs: 1 } }));
    const reopened = await openStateStore(dir);
    expect(reopened.read().killSwitch.engaged).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).killSwitch.reason).toBe("test");
    expect((await stat(join(dir, "state.json"))).mode & 0o777).toBe(0o600);
  });
});

describe("daily loss baseline", () => {
  it("resets at the first observation of each UTC day", async () => {
    const store = createMemoryStateStore();
    const day1 = Date.UTC(2026, 9, 11, 8);
    expect(await realizedTodayRaw(store, -5n, day1)).toBe(0n);
    expect(await realizedTodayRaw(store, -30n, day1 + 3_600_000)).toBe(-25n);
    expect(await realizedTodayRaw(store, -30n, Date.UTC(2026, 9, 12, 0, 1))).toBe(0n);
  });
});
