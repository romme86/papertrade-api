import type { Address } from "viem";

// Mirrors the canonical frontend's production deployment config
// (exchange.papertrade.xyz, build f318d7d811da, read 2026-10-11).
export const DEPLOYMENT = {
  chainId: 999,
  contracts: {
    exchange: "0x6cd5661646289fb6e65ea5c032310fded797d0a2",
    paper: "0xe40f17915daa230324030003a197cdaef2261c0e",
    paperStaking: "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016",
    depositProxyFactory: "0x1629b7d46bef6e13ff754174fc9f32dea309b38f",
  },
  governance: {
    multisig: "0x696292762fd5ac3677a45edbe54eaece4194d1f6",
    timelock: "0xb915fa41e824d6aa31bb833ee81220c0f2c8ea0f",
  },
} as const satisfies {
  chainId: number;
  contracts: Record<string, Address>;
  governance: Record<string, Address>;
};

export const MARKETS = {
  BTC: { instrumentId: 0, hlCoin: "BTC" },
  ETH: { instrumentId: 1, hlCoin: "ETH" },
} as const;

export type MarketSymbol = keyof typeof MARKETS;

export const marketSymbols = Object.keys(MARKETS) as MarketSymbol[];

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// The frontend signs every intent with a deadline one hour out.
export const INTENT_LIFETIME_SECONDS = 3_600;
// Session keys are registered for 30 days.
export const SESSION_LIFETIME_MS = 2_592_000_000;
// The frontend closes at most 12 positions per signed Close intent.
export const MAX_CLOSE_BATCH = 12;
// Win fee taken from the post-impact gain (docs: "A 2% win fee").
export const WIN_FEE_RATE = 0.02;
// Jitter deadband: a winning exit is measured entryPrice / 50000 less favourable.
export const DEADBAND_DIVISOR = 50_000;
