import type { Address } from "viem";

// EIP-712 definitions copied verbatim from the canonical frontend's
// typed-data chunk. Field order matters for the struct hash.
export const INTENT_TYPES = {
  RegisterSessionKey: [
    { name: "user", type: "address" },
    { name: "key", type: "address" },
    { name: "expiry", type: "uint64" },
    { name: "feeAddress", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  OpenPosition: [
    { name: "user", type: "address" },
    { name: "instrumentId", type: "uint32" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint128" },
    { name: "leverage", type: "uint32" },
    { name: "useDebt", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Close: [
    { name: "user", type: "address" },
    { name: "positionIds", type: "uint256[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  WithdrawToCore: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  CancelIntent: [
    { name: "user", type: "address" },
    { name: "intentId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type IntentType = keyof typeof INTENT_TYPES;

export type IntentDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

// The exchange domain name really is "String" in the frontend bundle; keep it verbatim.
export const exchangeDomain = (chainId: number, exchange: Address): IntentDomain => ({
  name: "String",
  version: "1",
  chainId,
  verifyingContract: exchange,
});

export const cancellationDomain = (chainId: number, exchange: Address): IntentDomain => ({
  name: "PaperTrade Intent Cancel",
  version: "2",
  chainId,
  verifyingContract: exchange,
});

export const INTENT_ID_TAG = "papertrade:intent-id:v2";
