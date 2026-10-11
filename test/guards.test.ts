import { describe, expect, it } from "vitest";
import type { RiskLimits } from "../src/config.js";
import { parseUsd } from "../src/lib/units.js";
import { checkOpen, type OpenCheckInput } from "../src/trading/guards.js";
import { instrumentFor } from "../src/trading/markets.js";
import { tradingState, usd, walletState } from "./fixtures.js";

const limits: RiskLimits = { maxMarginUsd: 100, maxLeverage: 100, maxOpenPositions: 3, maxTotalMarginUsd: 300, dailyLossLimitUsd: 50 };
const wallet = "0x000000000000000000000000000000000000dead";

const input = (overrides: Partial<OpenCheckInput> = {}): OpenCheckInput => {
  const trading = tradingState();
  return {
    marginRaw: parseUsd(100),
    leverage: 100,
    instrument: instrumentFor(trading, "BTC"),
    trading,
    wallet: walletState(wallet, { balance: usd(500), funds: { reservedBalance: "0", reservedQueued: "0", availableBalance: usd(500), availableQueued: "0" } }),
    walletAgeMs: 1_000,
    sessionValidForMs: 7 * 86_400_000,
    killSwitchEngaged: false,
    realizedTodayRaw: 0n,
    limits,
    snapshotMaxAgeMs: 30_000,
    ...overrides,
  };
};

const codes = (overrides: Partial<OpenCheckInput> = {}) => checkOpen(input(overrides)).map((v) => v.code);

describe("checkOpen", () => {
  it("accepts a $100 × 100x BTC open within limits", () => {
    expect(codes()).toEqual([]);
  });

  it("enforces Papertrade's $10k minimum position value", () => {
    expect(codes({ marginRaw: parseUsd(50) })).toContain("notional_below_min");
  });

  it("enforces our own caps", () => {
    expect(codes({ leverage: 200, marginRaw: parseUsd(60) })).toContain("limit_leverage");
    expect(codes({ marginRaw: parseUsd(150) })).toContain("limit_margin");
    expect(codes({ realizedTodayRaw: -parseUsd(50) })).toContain("limit_daily_loss");
  });

  it("blocks opens while the kill switch is engaged", () => {
    expect(codes({ killSwitchEngaged: true })).toContain("kill_switch");
  });

  it("requires a fresh wallet snapshot, funds and a valid session", () => {
    expect(codes({ wallet: null })).toContain("wallet_unknown");
    expect(codes({ walletAgeMs: 60_000 })).toContain("wallet_stale");
    expect(codes({ wallet: walletState(wallet) })).toContain("insufficient_funds");
    expect(codes({ sessionValidForMs: 30 * 60_000 })).toContain("session_invalid");
    expect(codes({ sessionValidForMs: null })).toContain("session_invalid");
  });

  it("counts open and pending positions against the position cap", () => {
    const full = walletState(wallet, {
      funds: { reservedBalance: "0", reservedQueued: "0", availableBalance: usd(500), availableQueued: "0" },
      openPositions: [
        ["1", 0, true, false, "831395", usd(10), 1000, "830000", 1, null],
        ["2", 0, true, false, "831395", usd(10), 1000, "830000", 1, null],
      ],
      operations: [[`0x${"cc".repeat(32)}`, "openPosition", 0, true, false, usd(10), 1000, 1, "2", null]],
    });
    expect(codes({ wallet: full })).toContain("limit_positions");
  });

  it("respects Papertrade pausing", () => {
    const trading = { ...tradingState(), tradingPaused: true };
    expect(codes({ trading })).toContain("trading_paused");
  });
});
