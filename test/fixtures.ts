import { TradingStateSchema, WalletSnapshotSchema, type TradingState } from "../src/protocol/schemas.js";
import type { WalletState } from "../src/clients/walletState.js";

// Captured from https://exchange.papertrade.xyz/state/trading on 2026-10-11.
export const tradingStateJson = {
  schemaVersion: 1,
  indexedThroughBlock: 48246581,
  tradingPaused: false,
  minimumTradeSizeRaw: "10000000000000000000",
  minimumOpenNotionalRaw: "10000000000000000000000",
  accRewardPerShareRaw: "9452840300027494115453393",
  instruments: [
    [0, "BTC", 0, "10", true, false, false, false, false, null, null, null, "15000000000000000000000", "814598000000000000000", 1000, "10000000000000000000000000", "476041580087574", "100000000000000000", "100000000000000000000000", "5208906743088206164622", "3753589637952925482802", "5392724486380858422072", "3951340761282735141435"],
    [1, "ETH", 1, "100", true, false, false, false, false, null, null, null, "15000000000000000000000", "483979000000000000000", 1000, "10000000000000000000000000", "481304050180130", "100000000000000000", "100000000000000000000000", "119678458573727979560574", "157517713170344282080799", "121019494923121211430996", "163579481848982070637824"],
  ],
  intake: [1791685001319699, "1000000000000000000000", "120000000000000000000000000", []],
};

export const tradingState = (): TradingState => TradingStateSchema.parse(tradingStateJson);

// Shape captured from /state/user/live for an empty wallet; balances overridden per test.
export const walletSnapshotJson = (address: string, overrides: Record<string, unknown> = {}) => ({
  address,
  indexedThroughBlock: 48254222,
  indexedThroughTimestamp: 1791719842,
  sessionKeys: [],
  walletRevision: 0,
  queueRevision: "0",
  balance: "0",
  queued: "0",
  locked: "0",
  funds: { reservedBalance: "0", reservedQueued: "0", availableBalance: "0", availableQueued: "0" },
  queueNodeCount: 0,
  consumableDebt: "0",
  paper: { balance: "0", staked: "0", pendingBase: "0", rewardDebt: "0" },
  lifetime: { depositedRaw: "0", withdrawnRaw: "0", realizedPnlRaw: "0", feesPaidRaw: "0", tradedNotionalRaw: "0", paperRewardsClaimedRaw: "0" },
  openPositions: [],
  operations: [],
  accountRevision: 1,
  ...overrides,
});

export const walletState = (address: string, overrides: Record<string, unknown> = {}): WalletState =>
  WalletSnapshotSchema.parse(walletSnapshotJson(address, overrides));

export const usd = (value: number): string => (BigInt(Math.round(value * 1e6)) * 10n ** 12n).toString();
