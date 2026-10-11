import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "./api/app.js";
import { createBuildIdProvider } from "./clients/buildId.js";
import { createHyperEvm } from "./clients/hyperevm.js";
import { createHyperliquidInfo } from "./clients/hyperliquid.js";
import { createPapertradeHttp } from "./clients/http.js";
import { createPapertradeQuery } from "./clients/papertradeQuery.js";
import { createRelayer } from "./clients/relayer.js";
import { createWalletStream } from "./clients/walletStream.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";
import { createMutex } from "./lib/mutex.js";
import { DEPLOYMENT } from "./protocol/deployment.js";
import { cancellationDomain, exchangeDomain } from "./protocol/typedData.js";
import { openAuditLog } from "./state/audit.js";
import { createNonceAllocator } from "./state/nonces.js";
import { openStateStore } from "./state/store.js";
import { createExecutor } from "./trading/executor.js";
import { createSessionManager } from "./trading/session.js";

const USER_AGENT = "papertrade-api/0.1 (+cassandrina)";
const RENEW_CHECK_INTERVAL_MS = 10 * 60_000;

const main = async () => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: "papertrade-api" });
  const wallet = privateKeyToAccount(config.walletPrivateKey);
  const exchange = exchangeDomain(DEPLOYMENT.chainId, DEPLOYMENT.contracts.exchange);
  const cancellation = cancellationDomain(DEPLOYMENT.chainId, DEPLOYMENT.contracts.exchange);

  const store = await openStateStore(config.dataDir);
  const audit = await openAuditLog(config.dataDir);
  const writeLock = createMutex();
  const nonces = createNonceAllocator(store, DEPLOYMENT.chainId, DEPLOYMENT.contracts.exchange, wallet.address);

  const buildId = createBuildIdProvider({ origin: config.papertradeOrigin, fallback: config.papertradeBuildId, logger });
  const http = createPapertradeHttp({ origin: config.papertradeOrigin, buildId, userAgent: USER_AGENT });
  const query = createPapertradeQuery(http);
  const relayer = createRelayer(http);
  const hyperliquid = createHyperliquidInfo(config.hyperliquidInfoUrl);
  const hyperevm = createHyperEvm(config.hyperevmRpcUrl);
  const stream = createWalletStream({ origin: config.papertradeOrigin, wallet: wallet.address, userAgent: USER_AGENT, logger });

  const session = createSessionManager({
    wallet,
    domain: exchange,
    relayer,
    walletState: stream.state,
    store,
    nonces,
    audit,
    writeLock,
    logger,
    renewBeforeMs: config.sessionRenewBeforeMs,
  });

  const executor = createExecutor({
    liveTrading: config.liveTrading,
    limits: config.limits,
    snapshotMaxAgeMs: config.snapshotMaxAgeMs,
    wallet,
    exchangeDomain: exchange,
    cancellationDomain: cancellation,
    query,
    relayer,
    stream,
    session,
    nonces,
    hyperliquid,
    store,
    audit,
    writeLock,
    logger,
  });

  stream.start();

  if (config.liveTrading && config.autoRenewSession) {
    const renew = () => session.maybeRenew().catch((error: Error) => logger.error("session renewal failed", { error }));
    // Give the wallet stream a moment to deliver its first snapshot.
    setTimeout(renew, 15_000);
    setInterval(renew, RENEW_CHECK_INTERVAL_MS).unref();
  }

  const app = createApp({ config, wallet, query, stream, hyperliquid, hyperevm, session, executor, store, logger });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  logger.info("listening", { host: config.host, port: config.port, mode: config.liveTrading ? "live" : "dry-run", wallet: wallet.address });

  const shutdown = () => {
    logger.info("shutting down");
    stream.stop();
    server.close();
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

main().catch((error: Error) => {
  process.stderr.write(`fatal: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
