import { describe, expect, it } from "vitest";
import { concat, recoverTypedDataAddress, type Hex } from "viem";
import { DEPLOYMENT } from "../src/protocol/deployment.js";
import { INTENT_TYPES } from "../src/protocol/typedData.js";
import { GuardError } from "../src/trading/executor.js";
import { claimableRewardsRaw } from "../src/trading/paperRewards.js";
import { usd } from "./fixtures.js";
import { fundedWallet, makeHarness, walletAccount } from "./harness.js";

const signatureOf = (body: Record<string, unknown>) => concat([body.r as Hex, body.s as Hex, `0x${Number(body.v).toString(16)}`]);
const paperRaw = (value: number) => (BigInt(value) * 10n ** 18n).toString();
const withPaper = (paper: Record<string, string>) =>
  fundedWallet({ paper: { balance: "0", staked: "0", pendingBase: "0", rewardDebt: "0", ...paper } });

const codesOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(GuardError);
  return (error as GuardError).violations.map((v) => v.code);
};

describe("PAPER staking", () => {
  it("previews a stake in dry-run without spending a nonce", async () => {
    const h = makeHarness({ liveTrading: false, wallet: withPaper({ balance: paperRaw(1_500) }) });
    const result = await h.paper.stake("all");
    expect(result).toMatchObject({ mode: "dry-run", action: "paperStake", amount: "1500", violations: [], submission: null });
    expect(result.message).not.toHaveProperty("r");
    expect(h.calls).toEqual([]);
    expect(h.store.read().nonces).toEqual({});
  });

  it("signs a live stake of the whole balance with the wallet key against the staking contract", async () => {
    const h = makeHarness({ liveTrading: true, wallet: withPaper({ balance: paperRaw(1_500) }) });
    const result = await h.paper.stake("all");
    expect(result.mode).toBe("live");
    const [call] = h.calls;
    expect(call).toMatchObject({ kind: "submit", action: "paperStake", body: { user: walletAccount.address.toLowerCase(), amount: paperRaw(1_500) } });
    const body = call!.body;
    const signer = await recoverTypedDataAddress({
      domain: h.paperDomain,
      types: { Stake: INTENT_TYPES.Stake },
      primaryType: "Stake",
      message: { user: body.user as Hex, amount: BigInt(body.amount as string), nonce: BigInt(body.nonce as string), deadline: BigInt(body.deadline as string) },
      signature: signatureOf(body),
    });
    expect(signer.toLowerCase()).toBe(walletAccount.address.toLowerCase());
    expect(h.paperDomain).toMatchObject({ name: "PaperStaking", version: "1", verifyingContract: DEPLOYMENT.contracts.paperStaking });
    const lanes = Object.keys(h.store.read().nonces);
    expect(lanes).toEqual([expect.stringContaining(`${DEPLOYMENT.contracts.paperStaking}:paper:`)]);
  });

  it("refuses a stake below Papertrade's minimum or above the balance", async () => {
    const h = makeHarness({ liveTrading: true, wallet: withPaper({ balance: paperRaw(127) }) });
    expect(await codesOf(h.paper.stake("all"))).toContain("below_minimum_paper_stake");
    expect(await codesOf(h.paper.stake("2000"))).toContain("insufficient_paper");
    expect(h.calls).toEqual([]);
  });

  it("refuses a second stake while one is queued", async () => {
    const queued = fundedWallet({
      paper: { balance: paperRaw(3_000), staked: "0", pendingBase: "0", rewardDebt: "0" },
      operations: [[`0x${"aa".repeat(32)}`, "paperStake", null, null, null, paperRaw(1_000), null, 1, "2", null]],
    });
    const h = makeHarness({ liveTrading: true, wallet: queued });
    expect(await codesOf(h.paper.stake("all"))).toContain("paper_pending");
  });

  it("claims only when rewards have accrued", async () => {
    const empty = makeHarness({ liveTrading: true, wallet: withPaper({}) });
    expect(await codesOf(empty.paper.claim())).toContain("nothing_to_claim");

    const h = makeHarness({ liveTrading: true, wallet: withPaper({ staked: paperRaw(1_000) }) });
    const result = await h.paper.claim();
    expect(result).toMatchObject({ mode: "live", action: "paperClaim", amount: null });
    expect(h.calls[0]).toMatchObject({ action: "paperClaim" });
    expect(h.calls[0]!.body).not.toHaveProperty("amount");
  });

  it("unstakes no more than is staked", async () => {
    const h = makeHarness({ liveTrading: true, wallet: withPaper({ staked: paperRaw(1_000) }) });
    expect(await codesOf(h.paper.unstake("1001"))).toContain("insufficient_staked");
    await h.paper.unstake("all");
    expect(h.calls[0]).toMatchObject({ action: "paperUnstake", body: { amount: paperRaw(1_000) } });
  });
});

describe("claimableRewardsRaw", () => {
  it("is pendingBase plus the staked share of the accumulator above the reward debt", () => {
    const paper = { balance: 0n, staked: 1_000n * 10n ** 18n, pendingBase: BigInt(usd(1)), rewardDebt: BigInt(usd(5)) };
    // 1,000 PAPER × 0.01 USD per PAPER = $10 accrued, minus $5 debt, plus $1 pending
    expect(claimableRewardsRaw(paper, 10n ** 25n)).toBe(BigInt(usd(6)));
    // debt above the accrual never goes negative
    expect(claimableRewardsRaw({ ...paper, rewardDebt: BigInt(usd(50)) }, 10n ** 25n)).toBe(BigInt(usd(1)));
  });
});
