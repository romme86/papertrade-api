import { randomBytes } from "node:crypto";
import type { Address } from "viem";
import type { StateStore } from "./store.js";

// Same scheme as the frontend: nonces are client-chosen, start at a random
// 24-bit value × 256 and count up per (chain, contract, lane, user).
export type NonceLane = "session" | "paper";

export type NonceAllocator = {
  take: (lane: NonceLane) => Promise<bigint>;
};

const KEY_PREFIX = "papertrade.clientNonce.v1";

export const randomNonceStart = (): bigint => {
  let value = 0n;
  for (const byte of randomBytes(3)) value = (value << 8n) + BigInt(byte);
  return (value || 1n) * 256n;
};

export const createNonceAllocator = (store: StateStore, chainId: number, verifyingContract: Address, user: Address): NonceAllocator => ({
  take: async (lane) => {
    const key = [KEY_PREFIX, chainId, verifyingContract.toLowerCase(), lane, user.toLowerCase()].join(":");
    let taken = 0n;
    await store.update((state) => {
      const stored = state.nonces[key];
      taken = stored ? BigInt(stored) : randomNonceStart();
      return { ...state, nonces: { ...state.nonces, [key]: String(taken + 1n) } };
    });
    return taken;
  },
});
