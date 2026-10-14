import type { PrivateKeyAccount } from "viem/accounts";
import type { PapertradeQuery } from "../clients/papertradeQuery.js";
import type { WalletState } from "../clients/walletState.js";
import type { WalletStream } from "../clients/walletStream.js";
import type { Mutex } from "../lib/mutex.js";
import { formatUsd, parseUsd } from "../lib/units.js";
import { INTENT_LIFETIME_SECONDS } from "../protocol/deployment.js";
import type { TradingState } from "../protocol/schemas.js";
import { deadlineFrom, previewIntent, signIntent, unsignedView, type IntentMessage } from "../protocol/signing.js";
import type { IntentDomain, IntentType } from "../protocol/typedData.js";
import type { NonceAllocator } from "../state/nonces.js";
import { GuardError, type WriteMode } from "./executor.js";
import type { Violation } from "./guards.js";
import { claimableRewardsRaw } from "./paperRewards.js";
import type { Submission, Submit } from "./submit.js";

// PAPER staking: stake / unstake are instant with no lockup; staked PAPER earns
// USDC that a separate Claim moves into the trading balance. These intents are
// signed by the wallet key against the staking contract, on their own nonce lane.

export type PaperAction = "paperStake" | "paperUnstake" | "paperClaim";
// "all" = the whole wallet balance (stake) or everything staked (unstake).
export type PaperAmount = string | "all";

export type PaperResult = {
  mode: WriteMode;
  action: PaperAction;
  // PAPER (18 decimals), null for a claim
  amount: string | null;
  violations: Violation[];
  message: Record<string, unknown>;
  submission: Submission | null;
};

type WriteOptions = { dryRun?: boolean };

export type PaperDesk = {
  stake: (amount: PaperAmount, options?: WriteOptions) => Promise<PaperResult>;
  unstake: (amount: PaperAmount, options?: WriteOptions) => Promise<PaperResult>;
  claim: (options?: WriteOptions) => Promise<PaperResult>;
};

const INTENT_TYPE: Record<PaperAction, IntentType> = { paperStake: "Stake", paperUnstake: "Unstake", paperClaim: "Claim" };

export type PaperCheckInput = {
  action: PaperAction;
  amountRaw: bigint | null;
  trading: TradingState;
  wallet: WalletState | null;
  walletAgeMs: number | null;
  snapshotMaxAgeMs: number;
};

// Every reason Papertrade (or the frontend's own checks) would refuse the request.
export const checkPaper = ({ action, amountRaw, trading, wallet, walletAgeMs, snapshotMaxAgeMs }: PaperCheckInput): Violation[] => {
  const v: Violation[] = [];
  const add = (code: string, message: string) => v.push({ code, message });
  if (trading.intake.pausedActions.includes(action)) add("intake_paused", `Papertrade intake for ${action} is paused`);
  if (!wallet) {
    add("wallet_unknown", "No wallet snapshot from Papertrade yet");
    return v;
  }
  if (walletAgeMs === null || walletAgeMs > snapshotMaxAgeMs) add("wallet_stale", "Wallet snapshot is stale");
  if (wallet.operations.some((op) => op.action === action)) add("paper_pending", `A ${action} is already queued`);

  if (action === "paperClaim") {
    const accumulator = trading.accRewardPerShareRaw;
    if (accumulator !== undefined && claimableRewardsRaw(wallet.paper, accumulator) === 0n) add("nothing_to_claim", "No staking rewards to claim");
    return v;
  }
  if (amountRaw === null || amountRaw <= 0n) {
    add("amount_invalid", action === "paperStake" ? "No PAPER to stake" : "No PAPER to unstake");
  } else if (action === "paperStake") {
    const minimum = trading.intake.minimumPaperStakeRaw;
    if (amountRaw < minimum) add("below_minimum_paper_stake", `Papertrade's minimum stake is ${formatUsd(minimum, 2)} PAPER`);
    if (amountRaw > wallet.paper.balance) add("insufficient_paper", `Only ${formatUsd(wallet.paper.balance, 2)} PAPER in the wallet`);
  } else if (amountRaw > wallet.paper.staked) {
    add("insufficient_staked", `Only ${formatUsd(wallet.paper.staked, 2)} PAPER staked`);
  }
  return v;
};

// PAPER has 18 decimals, like Papertrade's collateral amounts.
const resolveAmount = (amount: PaperAmount, action: PaperAction, wallet: WalletState | null): bigint | null => {
  if (amount !== "all") return parseUsd(amount);
  if (!wallet) return null;
  return action === "paperStake" ? wallet.paper.balance : wallet.paper.staked;
};

type Deps = {
  liveTrading: boolean;
  snapshotMaxAgeMs: number;
  wallet: PrivateKeyAccount;
  domain: IntentDomain;
  query: PapertradeQuery;
  stream: WalletStream;
  nonces: NonceAllocator;
  submit: Submit;
  writeLock: Mutex;
  now?: () => number;
};

export const createPaperDesk = (deps: Deps): PaperDesk => {
  const now = deps.now ?? Date.now;

  const evaluate = async (action: PaperAction, amount: PaperAmount | null) => {
    const trading = await deps.query.tradingState();
    const wallet = deps.stream.state();
    const lastEventAt = deps.stream.lastEventAt();
    const amountRaw = amount === null ? null : resolveAmount(amount, action, wallet);
    const violations = checkPaper({
      action,
      amountRaw,
      trading,
      wallet,
      walletAgeMs: lastEventAt === null ? null : now() - lastEventAt,
      snapshotMaxAgeMs: deps.snapshotMaxAgeMs,
    });
    const message: IntentMessage = {
      user: deps.wallet.address,
      ...(amountRaw !== null ? { amount: amountRaw } : {}),
      nonce: 0n,
      deadline: deadlineFrom(now(), INTENT_LIFETIME_SECONDS),
    };
    return { violations, amount: amountRaw === null ? null : formatUsd(amountRaw, 18), message };
  };

  const run = async (action: PaperAction, amount: PaperAmount | null, options: WriteOptions = {}): Promise<PaperResult> => {
    const type = INTENT_TYPE[action];
    if (!deps.liveTrading || options.dryRun === true) {
      const evaluated = await evaluate(action, amount);
      const signed = await previewIntent(deps.domain, type, evaluated.message);
      return { mode: "dry-run", action, ...evaluated, message: unsignedView(signed), submission: null };
    }
    return deps.writeLock(async () => {
      const evaluated = await evaluate(action, amount);
      if (evaluated.violations.length) throw new GuardError(evaluated.violations);
      const signed = await signIntent(deps.wallet, deps.domain, type, { ...evaluated.message, nonce: await deps.nonces.take("paper") });
      const submission = await deps.submit(action, signed, { amount: evaluated.amount });
      return { mode: "live", action, ...evaluated, message: unsignedView(signed), submission };
    });
  };

  return {
    stake: (amount, options) => run("paperStake", amount, options),
    unstake: (amount, options) => run("paperUnstake", amount, options),
    claim: (options) => run("paperClaim", null, options),
  };
};
