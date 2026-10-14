import { z } from "zod";

const flag = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((value) => value === "true");

const positive = (fallback: number) => z.coerce.number().positive().default(fallback);

const ConfigSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  API_TOKEN: z.string().min(32, "API_TOKEN must be at least 32 characters"),

  PAPERTRADE_ORIGIN: z.url().default("https://exchange.papertrade.xyz"),
  PAPERTRADE_BUILD_ID: z.string().optional(),
  HYPEREVM_RPC_URL: z.url().default("https://rpc.hyperliquid.xyz/evm"),
  HYPERLIQUID_INFO_URL: z.url().default("https://api.hyperliquid.xyz/info"),

  WALLET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key"),
  DATA_DIR: z.string().default("./data"),

  LIVE_TRADING: flag("false"),
  AUTO_RENEW_SESSION: flag("true"),
  SESSION_RENEW_BEFORE_HOURS: positive(72),

  MAX_MARGIN_USD: positive(100),
  MAX_LEVERAGE: z.coerce.number().int().positive().default(100),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(3),
  MAX_TOTAL_MARGIN_USD: positive(300),
  DAILY_LOSS_LIMIT_USD: positive(50),
  SNAPSHOT_MAX_AGE_MS: z.coerce.number().int().positive().default(30_000),

  CANDLE_SYNC: flag("true"),
  // Cassandrina's 2-year backtest: 730 days + 30-day look-back + 6-day warm-up.
  CANDLE_BACKFILL_DAYS: z.coerce.number().int().nonnegative().default(766),
  CANDLE_POLL_SECONDS: positive(60),
  BINANCE_FAPI_URL: z.url().default("https://fapi.binance.com/fapi/v1"),
  BINANCE_ARCHIVE_URL: z.url().default("https://data.binance.vision/data/futures/um/monthly/klines"),
});

export type Config = {
  host: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  apiToken: string;
  papertradeOrigin: string;
  papertradeBuildId: string | undefined;
  hyperevmRpcUrl: string;
  hyperliquidInfoUrl: string;
  walletPrivateKey: `0x${string}`;
  dataDir: string;
  liveTrading: boolean;
  autoRenewSession: boolean;
  sessionRenewBeforeMs: number;
  limits: RiskLimits;
  snapshotMaxAgeMs: number;
  candles: CandleConfig;
};

export type CandleConfig = {
  sync: boolean;
  backfillDays: number;
  pollMs: number;
  binanceRestUrl: string;
  binanceArchiveUrl: string;
};

export type RiskLimits = {
  maxMarginUsd: number;
  maxLeverage: number;
  maxOpenPositions: number;
  maxTotalMarginUsd: number;
  dailyLossLimitUsd: number;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = ConfigSchema.parse(env);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    apiToken: parsed.API_TOKEN,
    papertradeOrigin: parsed.PAPERTRADE_ORIGIN.replace(/\/$/, ""),
    papertradeBuildId: parsed.PAPERTRADE_BUILD_ID,
    hyperevmRpcUrl: parsed.HYPEREVM_RPC_URL,
    hyperliquidInfoUrl: parsed.HYPERLIQUID_INFO_URL,
    walletPrivateKey: parsed.WALLET_PRIVATE_KEY as `0x${string}`,
    dataDir: parsed.DATA_DIR,
    liveTrading: parsed.LIVE_TRADING,
    autoRenewSession: parsed.AUTO_RENEW_SESSION,
    sessionRenewBeforeMs: parsed.SESSION_RENEW_BEFORE_HOURS * 3_600_000,
    limits: {
      maxMarginUsd: parsed.MAX_MARGIN_USD,
      maxLeverage: parsed.MAX_LEVERAGE,
      maxOpenPositions: parsed.MAX_OPEN_POSITIONS,
      maxTotalMarginUsd: parsed.MAX_TOTAL_MARGIN_USD,
      dailyLossLimitUsd: parsed.DAILY_LOSS_LIMIT_USD,
    },
    snapshotMaxAgeMs: parsed.SNAPSHOT_MAX_AGE_MS,
    candles: {
      sync: parsed.CANDLE_SYNC,
      backfillDays: parsed.CANDLE_BACKFILL_DAYS,
      pollMs: parsed.CANDLE_POLL_SECONDS * 1000,
      binanceRestUrl: parsed.BINANCE_FAPI_URL.replace(/\/$/, ""),
      binanceArchiveUrl: parsed.BINANCE_ARCHIVE_URL.replace(/\/$/, ""),
    },
  };
};
