import { describe, expect, it } from "vitest";
import { concat, encodeAbiParameters, keccak256, stringToBytes, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEPLOYMENT } from "../src/protocol/deployment.js";
import { computeIntentId, deadlineFrom, intentDigest, signIntent } from "../src/protocol/signing.js";
import { INTENT_TYPES, cancellationDomain, exchangeDomain } from "../src/protocol/typedData.js";

const sessionKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const user = "0xabcdef0123456789abcdef0123456789abcdef01" as const;
const domain = exchangeDomain(DEPLOYMENT.chainId, DEPLOYMENT.contracts.exchange);

const openMessage = {
  user,
  instrumentId: 0n,
  isLong: true,
  size: 100n * 10n ** 18n,
  leverage: 100n,
  useDebt: false,
  nonce: 4_194_048n,
  deadline: 1_791_723_600n,
};

// Independent EIP-712 digest built from raw ABI encoding, to pin the type
// string, field order and domain without relying on hashTypedData.
const manualOpenDigest = (): Hex => {
  const domainTypeHash = keccak256(stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [domainTypeHash, keccak256(stringToBytes("String")), keccak256(stringToBytes("1")), 999n, DEPLOYMENT.contracts.exchange],
    ),
  );
  const typeHash = keccak256(
    stringToBytes("OpenPosition(address user,uint32 instrumentId,bool isLong,uint128 size,uint32 leverage,bool useDebt,uint256 nonce,uint64 deadline)"),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint32" },
        { type: "bool" },
        { type: "uint128" },
        { type: "uint32" },
        { type: "bool" },
        { type: "uint256" },
        { type: "uint64" },
      ],
      [typeHash, user, 0, true, openMessage.size, 100, false, openMessage.nonce, openMessage.deadline],
    ),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
};

describe("signIntent", () => {
  it("matches an independently encoded EIP-712 digest", () => {
    expect(intentDigest(domain, "OpenPosition", openMessage)).toBe(manualOpenDigest());
  });

  it("emits the frontend wire format", async () => {
    const { signed } = await signIntent(sessionKey, domain, "OpenPosition", openMessage);
    expect(signed).toMatchObject({
      user: user.toLowerCase(),
      instrumentId: "0",
      isLong: true,
      size: "100000000000000000000",
      leverage: "100",
      useDebt: false,
      nonce: "4194048",
      deadline: "1791723600",
    });
    expect(["27", "28"]).toContain(signed.v);
    expect(signed.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.s).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.keys(signed)).toEqual([...INTENT_TYPES.OpenPosition.map((f) => f.name), "v", "r", "s"]);
  });

  it("produces a signature that verifies for the session key", async () => {
    const { signed } = await signIntent(sessionKey, domain, "OpenPosition", openMessage);
    const signature = concat([signed.r, signed.s, `0x${Number(signed.v).toString(16)}`]);
    const valid = await verifyTypedData({
      address: sessionKey.address,
      domain,
      types: { OpenPosition: INTENT_TYPES.OpenPosition },
      primaryType: "OpenPosition",
      message: { ...openMessage, instrumentId: 0, leverage: 100 },
      signature,
    });
    expect(valid).toBe(true);
  });

  it("derives the intent id from tag hash, digest and signer", async () => {
    const result = await signIntent(sessionKey, domain, "OpenPosition", openMessage);
    const expected = keccak256(concat([keccak256(stringToBytes("papertrade:intent-id:v2")), result.digest, sessionKey.address.toLowerCase() as Hex]));
    expect(result.intentId).toBe(expected);
    expect(computeIntentId(result.digest, result.signer)).toBe(expected);
    expect(result.signer).toBe(sessionKey.address.toLowerCase());
  });

  it("stringifies uint256[] position ids for Close", async () => {
    const { signed } = await signIntent(sessionKey, domain, "Close", { user, positionIds: [142515n, 7n], nonce: 1n, deadline: 2n });
    expect(signed.positionIds).toEqual(["142515", "7"]);
  });

  it("signs CancelIntent on the cancellation domain without a nonce field", async () => {
    const intentId = `0x${"ab".repeat(32)}` as Hex;
    const { signed } = await signIntent(sessionKey, cancellationDomain(999, DEPLOYMENT.contracts.exchange), "CancelIntent", {
      user,
      intentId,
      deadline: 5n,
    });
    expect(signed).toMatchObject({ user: user.toLowerCase(), intentId, deadline: "5" });
    expect(signed).not.toHaveProperty("nonce");
  });

  it("rejects messages missing a typed field", async () => {
    await expect(signIntent(sessionKey, domain, "Close", { user, nonce: 1n, deadline: 2n })).rejects.toThrow("Close.positionIds is required");
  });
});

describe("deadlineFrom", () => {
  it("is whole seconds one lifetime ahead", () => {
    expect(deadlineFrom(1_791_720_000_999, 3600)).toBe(1_791_723_600n);
  });
});
