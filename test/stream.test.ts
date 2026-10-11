import { describe, expect, it } from "vitest";
import { readSse } from "../src/clients/sse.js";
import { applyWalletPatch, createOutcomeLog } from "../src/clients/walletState.js";
import { WalletPatchSchema } from "../src/protocol/schemas.js";
import { usd, walletState } from "./fixtures.js";

const wallet = "0x000000000000000000000000000000000000dead";
const intentA = `0x${"aa".repeat(32)}`;
const intentB = `0x${"bb".repeat(32)}`;

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

describe("readSse", () => {
  it("parses events split across chunks, skipping comments", async () => {
    const events = [];
    for await (const event of readSse(streamOf([": connected\n\nevent: liveness\ndata: {\"heartbeat", "IntervalMs\":10000}\n\nevent: wallet\r\ndata: {\"a\":1}\r\n\r\n"]))) {
      events.push(event);
    }
    expect(events).toEqual([
      { event: "liveness", data: '{"heartbeatIntervalMs":10000}' },
      { event: "wallet", data: '{"a":1}' },
    ]);
  });
});

describe("applyWalletPatch", () => {
  const base = walletState(wallet, {
    balance: usd(500),
    openPositions: [["1", 0, true, false, "831395", usd(100), 100, "823480", 1791720000000, intentA]],
    operations: [[intentB, "openPosition", 1, false, false, usd(50), 200, 1791720000000, "1791723600", null]],
  });

  const patch = (overrides: Record<string, unknown>) =>
    WalletPatchSchema.parse({
      address: wallet,
      accountRevision: 2,
      state: {},
      addedPositions: [],
      removedPositionIds: [],
      addedOperations: [],
      removedOperationIds: [],
      ...overrides,
    });

  it("adds and removes positions and operations and merges state", () => {
    const next = applyWalletPatch(
      base,
      patch({
        state: { balance: usd(450) },
        addedPositions: [["2", 1, false, false, "250665", usd(50), 200, "251800", 1791720001000, intentB]],
        removedOperationIds: [intentB],
        removedPositionIds: ["1"],
      }),
    );
    expect(next.balance).toBe(BigInt(usd(450)));
    expect(next.openPositions.map((p) => p.positionId)).toEqual([2n]);
    expect(next.operations).toEqual([]);
    expect(next.accountRevision).toBe(2);
  });

  it("ignores patches that are not newer than the current revision", () => {
    const stale = patch({ accountRevision: 1, state: { balance: "0" } });
    expect(applyWalletPatch(base, stale)).toBe(base);
  });

  it("records intent outcomes and closed positions", () => {
    const log = createOutcomeLog(2);
    log.record(
      patch({
        intentOutcomes: [[intentA, "succeeded"]],
        closedPositions: [["1", 0, true, usd(100), 100, false, `-${usd(12.5)}`, "1250"]],
      }),
    );
    expect(log.intent(intentA as `0x${string}`)?.outcome).toBe("succeeded");
    expect(log.closed(1n)?.netPnlRaw).toBe(-BigInt(usd(12.5)));
  });
});
