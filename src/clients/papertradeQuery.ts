import type { Address } from "viem";
import {
  DepositCheckSchema,
  TradingStateSchema,
  type HistoryKind,
  type TradingState,
} from "../protocol/schemas.js";
import type { PapertradeHttp } from "./http.js";

export type HistoryPage = { items: unknown[]; nextCursor: string | null };

export type PapertradeQuery = {
  tradingState: () => Promise<TradingState>;
  marketStats: () => Promise<unknown>;
  protocolSummary: () => Promise<unknown>;
  queueSummary: () => Promise<unknown>;
  relayerHealth: () => Promise<unknown>;
  notices: () => Promise<unknown>;
  history: (user: Address, kind: HistoryKind, options: { cursor?: string }) => Promise<HistoryPage>;
  depositAddress: (user: Address) => Promise<Address>;
};

export const createPapertradeQuery = (http: PapertradeHttp, stateCacheMs = 3_000): PapertradeQuery => {
  let cachedState: { value: TradingState; at: number } | null = null;

  return {
    tradingState: async () => {
      if (cachedState && Date.now() - cachedState.at < stateCacheMs) return cachedState.value;
      const value = TradingStateSchema.parse(await http.get("/state/trading"));
      cachedState = { value, at: Date.now() };
      return value;
    },
    marketStats: () => http.get("/query/protocol/market-stats"),
    protocolSummary: () => http.get("/query/protocol/summary"),
    queueSummary: () => http.get("/query/protocol/queue-summary"),
    relayerHealth: () => http.get("/relayer/health"),
    notices: () => http.get("/query/notices"),
    // The indexer only accepts its canonical query: limit=75 plus an optional cursor.
    history: async (user, kind, { cursor }) => {
      const params = new URLSearchParams({ limit: "75" });
      if (cursor) params.set("cursor", cursor);
      return (await http.get(`/query/accounts/${user.toLowerCase()}/${kind}?${params}`)) as HistoryPage;
    },
    depositAddress: async (user) =>
      DepositCheckSchema.parse(await http.post("/funding/deposits/check", { user: user.toLowerCase() }, { timeoutMs: 12_000 })).proxy,
  };
};
