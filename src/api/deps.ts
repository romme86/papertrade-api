import type { PrivateKeyAccount } from "viem/accounts";
import type { CandleStore } from "../candles/store.js";
import type { CandleSync } from "../candles/sync.js";
import type { HyperEvm } from "../clients/hyperevm.js";
import type { HyperliquidInfo } from "../clients/hyperliquid.js";
import type { PapertradeQuery } from "../clients/papertradeQuery.js";
import type { WalletStream } from "../clients/walletStream.js";
import type { Config } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { StateStore } from "../state/store.js";
import type { Executor } from "../trading/executor.js";
import type { PaperDesk } from "../trading/paper.js";
import type { SessionManager } from "../trading/session.js";

export type AppDeps = {
  config: Pick<Config, "apiToken" | "liveTrading" | "limits">;
  wallet: PrivateKeyAccount;
  query: PapertradeQuery;
  stream: WalletStream;
  hyperliquid: HyperliquidInfo;
  hyperevm: HyperEvm;
  session: SessionManager;
  executor: Executor;
  paper: PaperDesk;
  store: StateStore;
  // sync is null when CANDLE_SYNC=false; stored candles are still served
  candles: { store: CandleStore; sync: Pick<CandleSync, "status"> | null };
  logger: Logger;
  now?: () => number;
};
