import type { WalletState } from "../clients/walletState.js";

// The staking contract's MasterChef-style accounting, as the frontend computes
// it: claimable = pendingBase + max(0, staked × accumulator / 1e27 − rewardDebt).
// The result is USD in Papertrade's 18-decimal collateral units.
const ACCUMULATOR_SCALE = 10n ** 27n;

export const claimableRewardsRaw = (paper: WalletState["paper"], accRewardPerShareRaw: bigint): bigint => {
  const accrued = (paper.staked * accRewardPerShareRaw) / ACCUMULATOR_SCALE - paper.rewardDebt;
  return paper.pendingBase + (accrued > 0n ? accrued : 0n);
};
