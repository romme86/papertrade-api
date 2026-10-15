import { describe, expect, it } from "vitest";
import type { PapertradeHttp } from "../src/clients/http.js";
import { createPapertradeQuery } from "../src/clients/papertradeQuery.js";
import { silentLogger, type Logger } from "../src/lib/logger.js";
import { DEFAULT_INTAKE, TradingStateSchema } from "../src/protocol/schemas.js";
import { tradingStateJson } from "./fixtures.js";

const { intakeControls: _controls, ...withoutIntake } = tradingStateJson;
const minimumStakeRaw = 1_000n * 10n ** 18n;

describe("TradingStateSchema", () => {
  it("reads the intake controls Papertrade sends since 2026-10-15", () => {
    const state = TradingStateSchema.parse(tradingStateJson);
    expect(state.intake).toEqual({ revision: 1791673267280300, minimumPaperStakeRaw: minimumStakeRaw, pausedActions: [] });
    expect(state.intakeUnreadable).toBe(false);
  });

  it("still reads the older four-field intake", () => {
    const state = TradingStateSchema.parse({
      ...withoutIntake,
      intake: [1791685001319699, "1000000000000000000000", "120000000000000000000000000", ["paperStake"]],
    });
    expect(state.intake).toEqual({ revision: 1791685001319699, minimumPaperStakeRaw: minimumStakeRaw, pausedActions: ["paperStake"] });
  });

  it("assumes the frontend's defaults when the frame has no intake controls", () => {
    const state = TradingStateSchema.parse(withoutIntake);
    expect(state.intake).toEqual(DEFAULT_INTAKE);
    expect(state.intakeUnreadable).toBe(false);
  });

  it("keeps the frame usable when the intake controls change shape again", () => {
    const state = TradingStateSchema.parse({ ...withoutIntake, intakeControls: [7, "1000000000000000000000", "1", []] });
    expect(state.intake).toEqual(DEFAULT_INTAKE);
    expect(state.intakeUnreadable).toBe(true);
    expect(state.instruments.map((instrument) => instrument.symbol)).toEqual(["BTC", "ETH"]);
  });

  it("still rejects instruments it cannot read", () => {
    const [btc] = tradingStateJson.instruments;
    expect(() => TradingStateSchema.parse({ ...tradingStateJson, instruments: [btc!.slice(0, 22)] })).toThrow();
  });
});

describe("tradingState query", () => {
  it("warns once each time the intake controls become unreadable", async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (msg) => warnings.push(msg) };
    const unreadable = { ...withoutIntake, intakeControls: "?" };
    let frame: unknown = unreadable;
    const http: PapertradeHttp = { get: async () => frame, post: async () => ({}) };
    const query = createPapertradeQuery(http, { stateCacheMs: 0, logger });

    await query.tradingState();
    await query.tradingState();
    expect(warnings).toHaveLength(1);

    frame = tradingStateJson;
    expect((await query.tradingState()).intake.minimumPaperStakeRaw).toBe(minimumStakeRaw);
    frame = unreadable;
    await query.tradingState();
    expect(warnings).toHaveLength(2);
  });
});
