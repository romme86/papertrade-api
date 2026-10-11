import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { PapertradeQuery } from "../src/clients/papertradeQuery.js";
import type { Relayer } from "../src/clients/relayer.js";
import { createOutcomeLog, type WalletState } from "../src/clients/walletState.js";
import type { WalletStream } from "../src/clients/walletStream.js";
import type { RiskLimits } from "../src/config.js";
import { silentLogger } from "../src/lib/logger.js";
import { createMutex } from "../src/lib/mutex.js";
import { DEPLOYMENT } from "../src/protocol/deployment.js";
import { cancellationDomain, exchangeDomain } from "../src/protocol/typedData.js";
import { memoryAuditLog } from "../src/state/audit.js";
import { createNonceAllocator } from "../src/state/nonces.js";
import { createMemoryStateStore } from "../src/state/store.js";
import { createExecutor } from "../src/trading/executor.js";
import { createSessionManager } from "../src/trading/session.js";
import { tradingState, usd, walletState } from "./fixtures.js";

// Anvil's well-known public test keys; never funded on Hyperliquid.
export const walletAccount = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const sessionPrivateKey: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const sessionAccount = privateKeyToAccount(sessionPrivateKey);

export const NOW = Date.UTC(2026, 9, 11, 12);
export const limits: RiskLimits = { maxMarginUsd: 100, maxLeverage: 100, maxOpenPositions: 3, maxTotalMarginUsd: 300, dailyLossLimitUsd: 50 };

export const fundedWallet = (overrides: Record<string, unknown> = {}): WalletState =>
  walletState(walletAccount.address.toLowerCase(), {
    balance: usd(500),
    funds: { reservedBalance: "0", reservedQueued: "0", availableBalance: usd(500), availableQueued: "0" },
    sessionKeys: [[sessionAccount.address.toLowerCase(), String(Math.floor(NOW / 1000) + 20 * 86_400)]],
    ...overrides,
  });

export type RelayerCall = { kind: "submit" | "cancel"; action?: string; intentId?: Hex; body: Record<string, unknown> };

export const makeHarness = (options: { liveTrading: boolean; wallet?: WalletState | null; storedSession?: boolean }) => {
  const calls: RelayerCall[] = [];
  const auditSink: Record<string, unknown>[] = [];
  let wallet = options.wallet === undefined ? fundedWallet() : options.wallet;

  const store = createMemoryStateStore({
    sessionKeys:
      options.storedSession === false
        ? []
        : [{ privateKey: sessionPrivateKey, address: sessionAccount.address, expiresAtMs: NOW + 20 * 86_400_000, registeredAtMs: NOW - 86_400_000, intentId: null }],
  });

  const query: PapertradeQuery = {
    tradingState: async () => tradingState(),
    marketStats: async () => ({}),
    protocolSummary: async () => ({}),
    queueSummary: async () => ({}),
    relayerHealth: async () => ({ ok: true }),
    notices: async () => ({ notices: [] }),
    history: async () => ({ items: [], nextCursor: null }),
    depositAddress: async () => "0x1111111111111111111111111111111111111111",
  };

  const relayer: Relayer = {
    submit: async (action, signed) => {
      calls.push({ kind: "submit", action, body: signed });
      return { ok: true, action, state: "queued", queueRevision: 7n };
    },
    cancel: async (intentId, body) => {
      calls.push({ kind: "cancel", intentId, body });
      return { ok: true };
    },
  };

  const stream: WalletStream = {
    start: () => {},
    stop: () => {},
    state: () => wallet,
    lastEventAt: () => NOW - 1_000,
    outcomes: createOutcomeLog(),
    waitFor: async () => wallet!,
  };

  const writeLock = createMutex();
  const nonces = createNonceAllocator(store, DEPLOYMENT.chainId, DEPLOYMENT.contracts.exchange, walletAccount.address);
  const audit = memoryAuditLog(auditSink);
  const exchange = exchangeDomain(DEPLOYMENT.chainId, DEPLOYMENT.contracts.exchange);

  const session = createSessionManager({
    wallet: walletAccount,
    domain: exchange,
    relayer,
    walletState: () => wallet,
    store,
    nonces,
    audit,
    writeLock,
    logger: silentLogger,
    renewBeforeMs: 72 * 3_600_000,
    now: () => NOW,
  });

  const hyperliquid = { bbo: async () => ({ bid: 83_139, ask: 83_140, mid: 83_139.5, at: NOW }) };

  const executor = createExecutor({
    liveTrading: options.liveTrading,
    limits,
    snapshotMaxAgeMs: 30_000,
    wallet: walletAccount,
    exchangeDomain: exchange,
    cancellationDomain: cancellationDomain(DEPLOYMENT.chainId, DEPLOYMENT.contracts.exchange),
    query,
    relayer,
    stream,
    session,
    nonces,
    hyperliquid,
    store,
    audit,
    writeLock,
    logger: silentLogger,
    now: () => NOW,
  });

  return {
    calls,
    auditSink,
    store,
    query,
    stream,
    session,
    executor,
    hyperliquid,
    exchange,
    setWallet: (next: WalletState | null) => {
      wallet = next;
    },
  };
};
