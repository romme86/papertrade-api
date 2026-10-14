import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  concat,
  hashTypedData,
  keccak256,
  parseSignature,
  recoverAddress,
  stringToBytes,
  type Hex,
  type LocalAccount,
} from "viem";
import { randomNonceStart } from "../state/nonces.js";
import { INTENT_ID_TAG, INTENT_TYPES, type IntentDomain, type IntentType } from "./typedData.js";

export type IntentMessage = Record<string, bigint | boolean | string | readonly bigint[]>;

// Wire format the relayer expects: every field stringified the way the
// frontend's encoder does it, plus v/r/s with v as a decimal string.
export type SignedIntent = Record<string, string | boolean | string[]> & { v: string; r: Hex; s: Hex };

export type SignedIntentResult = {
  signed: SignedIntent;
  digest: Hex;
  signer: Hex;
  intentId: Hex;
};

const INTENT_TAG_HASH = keccak256(stringToBytes(INTENT_ID_TAG));

const encodeWireField = (type: string, value: unknown): string | boolean | string[] => {
  if (type === "uint256[]") return (value as readonly bigint[]).map((item) => BigInt(item).toString());
  if (type.startsWith("uint")) return BigInt(value as bigint).toString();
  if (type === "address" || type.startsWith("bytes")) return (value as string).toLowerCase();
  return value as boolean;
};

const fieldsFor = (primaryType: IntentType) => INTENT_TYPES[primaryType];

export const intentDigest = (domain: IntentDomain, primaryType: IntentType, message: IntentMessage): Hex =>
  hashTypedData({
    domain,
    types: { [primaryType]: fieldsFor(primaryType) },
    primaryType,
    message,
  } as Parameters<typeof hashTypedData>[0]);

export const computeIntentId = (digest: Hex, signer: Hex): Hex =>
  keccak256(concat([INTENT_TAG_HASH, digest, signer.toLowerCase() as Hex]));

export const signIntent = async (
  signer: LocalAccount,
  domain: IntentDomain,
  primaryType: IntentType,
  message: IntentMessage,
): Promise<SignedIntentResult> => {
  const fields = fieldsFor(primaryType);
  const typedMessage: IntentMessage = {};
  const wire: Record<string, string | boolean | string[]> = {};
  for (const { name, type } of fields) {
    const value = message[name];
    if (value === undefined) throw new Error(`${primaryType}.${name} is required`);
    typedMessage[name] = value;
    wire[name] = encodeWireField(type, value);
  }

  if (!signer.signTypedData) throw new Error("Signer cannot sign typed data");
  const signature = await signer.signTypedData({
    domain,
    types: { [primaryType]: fields },
    primaryType,
    message: typedMessage,
  } as Parameters<NonNullable<LocalAccount["signTypedData"]>>[0]);

  const { r, s, yParity } = parseSignature(signature);
  const signed: SignedIntent = {
    ...wire,
    v: String(27 + yParity),
    r: r.toLowerCase() as Hex,
    s: s.toLowerCase() as Hex,
  };

  const digest = intentDigest(domain, primaryType, typedMessage);
  const recovered = (await recoverAddress({ hash: digest, signature })).toLowerCase() as Hex;
  if (recovered !== signer.address.toLowerCase()) {
    throw new Error("Recovered signer does not match the signing key");
  }
  return { signed, digest, signer: recovered, intentId: computeIntentId(digest, recovered) };
};

export const deadlineFrom = (nowMs: number, lifetimeSeconds: number): bigint =>
  BigInt(Math.floor(nowMs / 1000) + lifetimeSeconds);

// Dry-runs sign with a throwaway key and a random nonce: the encoding is
// exercised, but nothing produced could ever be replayed on our account.
export const previewIntent = (domain: IntentDomain, primaryType: IntentType, message: IntentMessage): Promise<SignedIntentResult> =>
  signIntent(privateKeyToAccount(generatePrivateKey()), domain, primaryType, { ...message, nonce: randomNonceStart() });

// Strip v/r/s so previews and responses never expose a usable signature.
export const unsignedView = ({ signed }: SignedIntentResult): Record<string, unknown> => {
  const { v: _v, r: _r, s: _s, ...message } = signed;
  return message;
};
