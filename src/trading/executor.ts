import type { PrivateKeyAccount } from "viem/accounts";
import type { Hex, LocalAccount } from "viem";
import type { HyperliquidInfo } from "../clients/hyperliquid.js";
import type { PapertradeQuery } from "../clients/papertradeQuery.js";
import type { Relayer } from "../clients/relayer.js";
import type { WalletStream } from "../clients/walletStream.js";
import type { RiskLimits } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { Mutex } from "../lib/mutex.js";
import { parseUsd, rawToNumber } from "../lib/units.js";
import { INTENT_LIFETIME_SECONDS, MARKETS, MAX_CLOSE_BATCH, type MarketSymbol } from "../protocol/deployment.js";
import { deadlineFrom, previewIntent, signIntent, unsignedView, type IntentMessage } from "../protocol/signing.js";
import type { IntentDomain } from "../protocol/typedData.js";
import type { AuditLog } from "../state/audit.js";
import type { NonceAllocator } from "../state/nonces.js";
import type { StateStore } from "../state/store.js";
import { realizedTodayRaw } from "./dailyLoss.js";
import { checkOpen, type Violation } from "./guards.js";
import { createSubmitter, type Submission } from "./submit.js";
import { instrumentFor } from "./markets.js";
import { buildQuote, impactParams, type Quote } from "./quote.js";
import type { SessionManager } from "./session.js";

export class GuardError extends Error {
  constructor(readonly violations: Violation[]) {
    super(violations.map((v) => v.message).join("; "));
    this.name = "GuardError";
  }
}

export type OpenRequest = {
  market: MarketSymbol;
  side: "long" | "short";
  marginUsd: string | number;
  leverage: number;
  dryRun?: boolean;
};

export type WriteMode = "live" | "dry-run";
export type { Submission };

export type OpenResult = {
  mode: WriteMode;
  violations: Violation[];
  quote: Quote;
  bbo: { bid: number; ask: number; mid: number };
  message: Record<string, unknown>;
  submission: Submission | null;
};

export type CloseResult = {
  mode: WriteMode;
  batches: { positionIds: string[]; message: Record<string, unknown>; submission: Submission | null }[];
};

export type Executor = {
  open: (request: OpenRequest) => Promise<OpenResult>;
  close: (positionIds: bigint[], options?: { dryRun?: boolean }) => Promise<CloseResult>;
  closeAll: (options?: { dryRun?: boolean }) => Promise<CloseResult>;
  cancel: (intentId: Hex, options?: { dryRun?: boolean }) => Promise<{ mode: WriteMode; response: unknown }>;
};

type Deps = {
  liveTrading: boolean;
  limits: RiskLimits;
  snapshotMaxAgeMs: number;
  wallet: PrivateKeyAccount;
  exchangeDomain: IntentDomain;
  cancellationDomain: IntentDomain;
  query: PapertradeQuery;
  relayer: Relayer;
  stream: WalletStream;
  session: SessionManager;
  nonces: NonceAllocator;
  hyperliquid: HyperliquidInfo;
  store: StateStore;
  audit: AuditLog;
  writeLock: Mutex;
  logger: Logger;
  now?: () => number;
};

export const createExecutor = (deps: Deps): Executor => {
  const now = deps.now ?? Date.now;
  const isLive = (dryRun?: boolean) => deps.liveTrading && dryRun !== true;

  const requireSigner = (): LocalAccount => {
    const signer = deps.session.activeSigner();
    if (!signer) throw new GuardError([{ code: "session_invalid", message: "No registered session key" }]);
    return signer;
  };

  const preview = previewIntent;

  const submit = createSubmitter(deps);

  const evaluateOpen = async (request: OpenRequest) => {
    const marginRaw = parseUsd(request.marginUsd);
    const trading = await deps.query.tradingState();
    const instrument = instrumentFor(trading, request.market);
    const wallet = deps.stream.state();
    const lastEventAt = deps.stream.lastEventAt();
    const violations = checkOpen({
      marginRaw,
      leverage: request.leverage,
      instrument,
      trading,
      wallet,
      walletAgeMs: lastEventAt === null ? null : now() - lastEventAt,
      sessionValidForMs: deps.session.status().validForMs,
      killSwitchEngaged: deps.store.read().killSwitch.engaged,
      realizedTodayRaw: wallet ? await realizedTodayRaw(deps.store, wallet.lifetime.realizedPnlRaw, now()) : 0n,
      limits: deps.limits,
      snapshotMaxAgeMs: deps.snapshotMaxAgeMs,
    });
    const bbo = await deps.hyperliquid.bbo(MARKETS[request.market].hlCoin);
    const quote = buildQuote(
      { isLong: request.side === "long", marginUsd: rawToNumber(marginRaw), leverage: request.leverage, entryPrice: bbo.mid },
      impactParams(instrument),
    );
    const message: IntentMessage = {
      user: deps.wallet.address,
      instrumentId: BigInt(instrument.id),
      isLong: request.side === "long",
      size: marginRaw,
      leverage: BigInt(request.leverage),
      useDebt: false,
      nonce: 0n,
      deadline: deadlineFrom(now(), INTENT_LIFETIME_SECONDS),
    };
    return { violations, quote, bbo: { bid: bbo.bid, ask: bbo.ask, mid: bbo.mid }, message };
  };

  const open: Executor["open"] = async (request) => {
    if (!isLive(request.dryRun)) {
      const evaluated = await evaluateOpen(request);
      const signed = await preview(deps.exchangeDomain, "OpenPosition", evaluated.message);
      return { mode: "dry-run", ...evaluated, message: unsignedView(signed), submission: null };
    }
    return deps.writeLock(async () => {
      const evaluated = await evaluateOpen(request);
      if (evaluated.violations.length) throw new GuardError(evaluated.violations);
      const signer = requireSigner();
      const signed = await signIntent(signer, deps.exchangeDomain, "OpenPosition", {
        ...evaluated.message,
        nonce: await deps.nonces.take("session"),
      });
      const submission = await submit("openPosition", signed, { request, quote: { entry: evaluated.bbo.mid, bust: evaluated.quote.bustPrice } });
      return { mode: "live", ...evaluated, message: unsignedView(signed), submission };
    });
  };

  const closingIds = () =>
    new Set(
      (deps.stream.state()?.operations ?? [])
        .filter((op) => op.action === "closePositions")
        .flatMap((op) => op.positionIds ?? []),
    );

  const close: Executor["close"] = async (positionIds, options = {}) => {
    const live = isLive(options.dryRun);
    const run = async (): Promise<CloseResult> => {
      const ids = [...new Set(positionIds)];
      if (!ids.length) return { mode: live ? "live" : "dry-run", batches: [] };
      if (live) {
        const open = new Set(deps.stream.state()?.openPositions.map((p) => p.positionId) ?? []);
        const unknown = ids.filter((id) => !open.has(id));
        if (unknown.length) {
          throw new GuardError([{ code: "unknown_position", message: `Not open on this wallet: ${unknown.join(", ")}` }]);
        }
      }
      const batches: CloseResult["batches"] = [];
      for (let i = 0; i < ids.length; i += MAX_CLOSE_BATCH) {
        const chunk = ids.slice(i, i + MAX_CLOSE_BATCH);
        const message: IntentMessage = { user: deps.wallet.address, positionIds: chunk, nonce: 0n, deadline: deadlineFrom(now(), INTENT_LIFETIME_SECONDS) };
        if (!live) {
          batches.push({ positionIds: chunk.map(String), message: unsignedView(await preview(deps.exchangeDomain, "Close", message)), submission: null });
          continue;
        }
        const signed = await signIntent(requireSigner(), deps.exchangeDomain, "Close", { ...message, nonce: await deps.nonces.take("session") });
        batches.push({ positionIds: chunk.map(String), message: unsignedView(signed), submission: await submit("closePositions", signed, {}) });
      }
      return { mode: live ? "live" : "dry-run", batches };
    };
    return live ? deps.writeLock(run) : run();
  };

  const closeAll: Executor["closeAll"] = (options = {}) => {
    const pending = closingIds();
    const ids = (deps.stream.state()?.openPositions ?? []).map((p) => p.positionId).filter((id) => !pending.has(id));
    return close(ids, options);
  };

  const cancel: Executor["cancel"] = async (intentId, options = {}) => {
    const message: IntentMessage = { user: deps.wallet.address, intentId, deadline: deadlineFrom(now(), INTENT_LIFETIME_SECONDS) };
    if (!isLive(options.dryRun)) {
      return { mode: "dry-run", response: unsignedView(await preview(deps.cancellationDomain, "CancelIntent", message)) };
    }
    return deps.writeLock(async () => {
      const signed = await signIntent(requireSigner(), deps.cancellationDomain, "CancelIntent", message);
      const { intentId: _id, ...body } = signed.signed;
      await deps.audit.write({ event: "submit", action: "cancelIntent", intentId, signed: signed.signed });
      const response = await deps.relayer.cancel(intentId, body);
      await deps.audit.write({ event: "accepted", action: "cancelIntent", intentId, response });
      return { mode: "live", response };
    });
  };

  return { open, close, closeAll, cancel };
};
