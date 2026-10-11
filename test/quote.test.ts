import { describe, expect, it } from "vitest";
import { instrumentFor } from "../src/trading/markets.js";
import { buildQuote, estimateBustPrice, impactParams, impactScale, settleClose } from "../src/trading/quote.js";
import { tradingState } from "./fixtures.js";

const btc = impactParams(instrumentFor(tradingState(), "BTC"));

describe("impact model (BTC launch params)", () => {
  it("decodes the live instrument parameters", () => {
    expect(btc.baseRate).toBeCloseTo(0.1);
    expect(btc.rateMultiplier).toBeCloseTo(15_000);
    expect(btc.positionMultiplier).toBeCloseTo(814.598);
    expect(btc.referenceNotional).toBeCloseTo(100_000);
    expect(btc.bustBuffer).toBeCloseTo(0.000476, 6);
  });

  // Docs: "counting the deadband, a 1% move keeps about 88% of the raw gain and a 0.1% move about 74%" (before the win fee).
  it.each([
    [0.01, 0.88],
    [0.001, 0.74],
  ])("a %s move keeps ~%s of the gain before the win fee", (move, keep) => {
    const settled = settleClose({ isLong: true, notional: 10_000, entry: 100_000, exit: 100_000 * (1 + move) }, btc, 0);
    expect(settled.keepFraction).toBeCloseTo(keep, 2);
  });

  it("never keeps more than (1 - baseRate)(1 - winFee)", () => {
    expect(impactScale(10, btc)).toBeLessThan(0.9);
    const huge = settleClose({ isLong: true, notional: 1_000, entry: 100, exit: 1_000 }, btc);
    expect(huge.keepFraction).toBeLessThan(0.9 * 0.98);
  });

  it("charges nothing extra on losses", () => {
    const settled = settleClose({ isLong: true, notional: 10_000, entry: 100, exit: 99 }, btc);
    expect(settled.netPnl).toBeCloseTo(-100);
    expect(settled.keepFraction).toBe(1);
  });

  it("zeroes wins inside the 0.2 bps deadband", () => {
    const settled = settleClose({ isLong: false, notional: 10_000, entry: 100_000, exit: 99_999 }, btc);
    expect(settled.rawPnl).toBeGreaterThan(0);
    expect(settled.netPnl).toBe(0);
  });
});

describe("bust price", () => {
  it("matches the docs example ($100 long at 100x trips near $99.05)", () => {
    expect(estimateBustPrice(100, 100, true, 0.0005)).toBeCloseTo(99.05, 6);
    expect(estimateBustPrice(100, 100, false, 0.0005)).toBeCloseTo(100.95, 6);
  });

  it("quotes notional, bust distance and a keep curve", () => {
    const quote = buildQuote({ isLong: true, marginUsd: 100, leverage: 100, entryPrice: 83_139.5, exitPrice: 84_000 }, btc);
    expect(quote.notionalUsd).toBe(10_000);
    expect(quote.adverseMoveToBustPct).toBeCloseTo(0.952, 2);
    expect(quote.keepCurve.map((p) => p.movePct)).toEqual([0.05, 0.1, 0.2, 0.5, 1, 2, 5]);
    expect(quote.scenario?.netPnl).toBeGreaterThan(0);
  });
});
