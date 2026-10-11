import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, LocalAccount } from "viem";
import type { Relayer } from "../clients/relayer.js";
import type { WalletState } from "../clients/walletState.js";
import type { Logger } from "../lib/logger.js";
import type { Mutex } from "../lib/mutex.js";
import { INTENT_LIFETIME_SECONDS, SESSION_LIFETIME_MS, ZERO_ADDRESS } from "../protocol/deployment.js";
import { deadlineFrom, signIntent } from "../protocol/signing.js";
import type { IntentDomain } from "../protocol/typedData.js";
import type { AuditLog } from "../state/audit.js";
import type { NonceAllocator } from "../state/nonces.js";
import type { StateStore, StoredSessionKey } from "../state/store.js";

export type SessionStatus = {
  activeKey: Address | null;
  expiresAtMs: number | null;
  validForMs: number | null;
  pendingKeys: Address[];
};

export type SessionManager = {
  status: () => SessionStatus;
  activeSigner: () => LocalAccount | null;
  register: () => Promise<{ key: Address; intentId: string; response: unknown }>;
  maybeRenew: () => Promise<void>;
};

type Deps = {
  wallet: PrivateKeyAccount;
  domain: IntentDomain;
  relayer: Relayer;
  walletState: () => WalletState | null;
  store: StateStore;
  nonces: NonceAllocator;
  audit: AuditLog;
  writeLock: Mutex;
  logger: Logger;
  renewBeforeMs: number;
  now?: () => number;
};

const MAX_STORED_KEYS = 4;
const PENDING_GRACE_MS = 10 * 60_000;

// A stored key counts only once Papertrade's wallet snapshot lists it as registered.
const registeredExpiryMs = (state: WalletState | null, key: StoredSessionKey): number | null => {
  const entry = state?.sessionKeys.find((item) => item.key === key.address.toLowerCase());
  return entry ? Number(entry.expiry) * 1000 : null;
};

export const createSessionManager = (deps: Deps): SessionManager => {
  const now = deps.now ?? Date.now;

  const active = (): { key: StoredSessionKey; expiresAtMs: number } | null => {
    const state = deps.walletState();
    for (const key of deps.store.read().sessionKeys) {
      const expiresAtMs = registeredExpiryMs(state, key);
      if (expiresAtMs !== null && expiresAtMs > now()) return { key, expiresAtMs };
    }
    return null;
  };

  const status = (): SessionStatus => {
    const current = active();
    const state = deps.walletState();
    return {
      activeKey: current?.key.address ?? null,
      expiresAtMs: current?.expiresAtMs ?? null,
      validForMs: current ? current.expiresAtMs - now() : null,
      pendingKeys: deps.store
        .read()
        .sessionKeys.filter((key) => registeredExpiryMs(state, key) === null)
        .map((key) => key.address),
    };
  };

  const register: SessionManager["register"] = () =>
    deps.writeLock(async () => {
      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      const expirySeconds = Math.floor((now() + SESSION_LIFETIME_MS) / 1000);
      const nonce = await deps.nonces.take("session");
      const result = await signIntent(deps.wallet, deps.domain, "RegisterSessionKey", {
        user: deps.wallet.address,
        key: account.address,
        expiry: BigInt(expirySeconds),
        feeAddress: ZERO_ADDRESS,
        nonce,
        deadline: deadlineFrom(now(), INTENT_LIFETIME_SECONDS),
      });

      // Persist before submitting so a crash can't orphan a registered key.
      const stored: StoredSessionKey = {
        privateKey,
        address: account.address,
        expiresAtMs: expirySeconds * 1000,
        registeredAtMs: now(),
        intentId: result.intentId,
      };
      const state = deps.walletState();
      await deps.store.update((s) => ({
        ...s,
        sessionKeys: [stored, ...s.sessionKeys]
          .filter((key, index) => index === 0 || registeredExpiryMs(state, key) !== null || now() - key.registeredAtMs < PENDING_GRACE_MS)
          .slice(0, MAX_STORED_KEYS),
      }));

      await deps.audit.write({ event: "submit", action: "registerSessionKey", intentId: result.intentId, key: account.address, signed: result.signed });
      try {
        const response = await deps.relayer.submit("registerSessionKey", result.signed);
        await deps.audit.write({ event: "accepted", action: "registerSessionKey", intentId: result.intentId, response });
        deps.logger.info("session key registration accepted", { key: account.address, expiresAtMs: stored.expiresAtMs });
        return { key: account.address, intentId: response.intentId ?? result.intentId, response };
      } catch (error) {
        await deps.audit.write({ event: "rejected", action: "registerSessionKey", intentId: result.intentId, error });
        throw error;
      }
    });

  const maybeRenew = async () => {
    const current = status();
    const recentlyRequested = deps.store.read().sessionKeys.some((key) => now() - key.registeredAtMs < PENDING_GRACE_MS && current.pendingKeys.includes(key.address));
    if (recentlyRequested) return;
    if (current.validForMs === null || current.validForMs < deps.renewBeforeMs) {
      deps.logger.info("renewing session key", { validForMs: current.validForMs });
      await register();
    }
  };

  return {
    status,
    activeSigner: () => {
      const current = active();
      return current ? privateKeyToAccount(current.key.privateKey) : null;
    },
    register,
    maybeRenew,
  };
};
