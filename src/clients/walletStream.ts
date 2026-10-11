import type { Address } from "viem";
import type { Logger } from "../lib/logger.js";
import { WalletPatchSchema, WalletSnapshotSchema } from "../protocol/schemas.js";
import { readSse } from "./sse.js";
import { applyWalletPatch, createOutcomeLog, type OutcomeLog, type WalletState } from "./walletState.js";

export type WalletStream = {
  start: () => void;
  stop: () => void;
  state: () => WalletState | null;
  lastEventAt: () => number | null;
  outcomes: OutcomeLog;
  // Resolves once the streamed state satisfies the predicate.
  waitFor: (predicate: (state: WalletState) => boolean, timeoutMs: number) => Promise<WalletState>;
};

type Options = {
  origin: string;
  wallet: Address;
  userAgent: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  // Reconnect periodically to re-baseline from a full snapshot.
  resyncMs?: number;
};

export const createWalletStream = ({ origin, wallet, userAgent, logger, fetchImpl = fetch, resyncMs = 5 * 60_000 }: Options): WalletStream => {
  const outcomes = createOutcomeLog();
  const listeners = new Set<() => void>();
  let current: WalletState | null = null;
  let lastEventAt: number | null = null;
  let controller: AbortController | null = null;
  let running = false;

  const notify = () => listeners.forEach((listener) => listener());

  const handleFrame = (data: string) => {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if ("state" in frame) {
      const patch = WalletPatchSchema.parse(frame);
      outcomes.record(patch);
      if (!current) throw new Error("Received a wallet patch before the snapshot");
      current = applyWalletPatch(current, patch);
    } else {
      current = WalletSnapshotSchema.parse(frame);
    }
    notify();
  };

  const connectOnce = async () => {
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), resyncMs);
    try {
      const response = await fetchImpl(`${origin}/state/user/live?wallet=${encodeURIComponent(wallet.toLowerCase())}`, {
        headers: { Accept: "text/event-stream", "User-Agent": userAgent },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`wallet stream returned ${response.status}`);
      for await (const { event, data } of readSse(response.body)) {
        lastEventAt = Date.now();
        if (event === "wallet") handleFrame(data);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const loop = async () => {
    let backoffMs = 1_000;
    while (running) {
      try {
        await connectOnce();
        backoffMs = 1_000;
        // Server closed the stream cleanly; pause briefly before reconnecting.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      } catch (error) {
        if (!running) return;
        const resync = controller?.signal.aborted;
        if (!resync) {
          logger.warn("wallet stream disconnected", { error, retryInMs: backoffMs });
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 30_000);
        }
      }
    }
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      void loop();
    },
    stop: () => {
      running = false;
      controller?.abort();
    },
    state: () => current,
    lastEventAt: () => lastEventAt,
    outcomes,
    waitFor: (predicate, timeoutMs) =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (current && predicate(current)) {
            cleanup();
            resolve(current);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for wallet state"));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          listeners.delete(check);
        };
        listeners.add(check);
        check();
      }),
  };
};
