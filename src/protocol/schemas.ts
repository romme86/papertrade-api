import { z } from "zod";
import type { Address, Hex } from "viem";

// Wire schemas for exchange.papertrade.xyz. Tuple layouts mirror the
// canonical frontend's zod parsers (account-wire chunk).

const uint = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const int = z.union([z.string().regex(/^-?\d+$/), z.number().int()]).transform((v) => BigInt(v));
const smallInt = z.number().int().nonnegative();
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase() as Address);
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as Hex);

export const IntentActionSchema = z.enum([
  "registerSessionKey",
  "openPosition",
  "closePositions",
  "paperStake",
  "paperUnstake",
  "paperClaim",
  "paperDistribute",
  "registerDeposit",
  "withdrawToCore",
]);
export type IntentAction = z.infer<typeof IntentActionSchema>;

const InstrumentTupleSchema = z
  .tuple([
    smallInt, // id
    z.string().min(1).max(32), // symbol
    smallInt, // HyperCore asset index
    uint, // price scale
    z.boolean(), // active
    z.boolean(), // paused
    z.boolean(), // terminal
    z.boolean(), // retired
    z.boolean(), // close only
    uint.nullable(), // frozen bid
    uint.nullable(), // frozen ask
    z.number().int().nullable(), // paused at ms
    uint, // rate multiplier (1e18)
    uint, // position multiplier (1e18)
    smallInt, // max leverage
    uint, // max position notional (1e18)
    uint, // bust buffer (1e18 fraction of price)
    uint, // base rate (1e18)
    uint, // reference notional (1e18)
    uint, // long OI
    uint, // short OI
    uint, // long cap
    uint, // short cap
  ])
  .transform(
    ([
      id,
      symbol,
      assetIndex,
      priceScale,
      active,
      paused,
      terminal,
      retired,
      closeOnly,
      frozenBidRaw,
      frozenAskRaw,
      pausedAtMs,
      rateMultiplierRaw,
      positionMultiplierRaw,
      maxLeverage,
      maxPositionNotionalRaw,
      bustBufferRaw,
      baseRateRaw,
      referenceNotionalRaw,
      longOiRaw,
      shortOiRaw,
      longCapRaw,
      shortCapRaw,
    ]) => ({
      id,
      symbol,
      assetIndex,
      priceScale,
      active,
      paused,
      openable: active && !paused,
      terminal,
      retired,
      closeOnly,
      frozenBidRaw,
      frozenAskRaw,
      pausedAtMs,
      rateMultiplierRaw,
      positionMultiplierRaw,
      maxLeverage,
      maxPositionNotionalRaw,
      bustBufferRaw,
      baseRateRaw,
      referenceNotionalRaw,
      longOiRaw,
      shortOiRaw,
      longCapRaw,
      shortCapRaw,
    }),
  );
export type Instrument = z.infer<typeof InstrumentTupleSchema>;

const IntakeTupleSchema = z
  .tuple([z.number(), uint, uint, z.array(z.string())])
  .transform(([revision, minimumPaperStakeRaw, maximumNetOpenInterestRaw, pausedActions]) => ({
    revision,
    minimumPaperStakeRaw,
    maximumNetOpenInterestRaw,
    pausedActions,
  }));

export const TradingStateSchema = z.object({
  schemaVersion: z.number().int(),
  indexedThroughBlock: z.number().int(),
  tradingPaused: z.boolean(),
  minimumTradeSizeRaw: uint,
  minimumOpenNotionalRaw: uint,
  instruments: z.array(InstrumentTupleSchema),
  intake: IntakeTupleSchema,
});
export type TradingState = z.infer<typeof TradingStateSchema>;

const PositionTupleSchema = z
  .tuple([uint, smallInt, z.boolean(), z.boolean(), uint, uint, smallInt, uint, z.number().int(), bytes32.nullable()])
  .transform(
    ([positionId, instrumentId, isLong, useDebt, entryPriceRaw, marginRaw, leverage, bustPriceRaw, openedAtMs, intentId]) => ({
      positionId,
      instrumentId,
      isLong,
      useDebt,
      entryPriceRaw,
      marginRaw,
      leverage,
      bustPriceRaw,
      openedAtMs,
      intentId,
    }),
  );
export type Position = z.infer<typeof PositionTupleSchema>;

const OperationTupleSchema = z
  .tuple([
    bytes32,
    IntentActionSchema,
    smallInt.nullable(),
    z.boolean().nullable(),
    z.boolean().nullable(),
    uint.nullable(),
    smallInt.nullable(),
    z.number().int(),
    uint,
    z.array(uint).nullable(),
  ])
  .transform(([intentId, action, instrumentId, isLong, useDebt, amountRaw, leverage, acceptedAtMs, deadline, positionIds]) => ({
    intentId,
    action,
    instrumentId,
    isLong,
    useDebt,
    amountRaw,
    leverage,
    acceptedAtMs,
    deadline,
    positionIds,
  }));
export type Operation = z.infer<typeof OperationTupleSchema>;

const ClosedPositionTupleSchema = z
  .tuple([uint, smallInt, z.boolean(), uint, smallInt, z.boolean(), int, uint])
  .transform(([positionId, instrumentId, isLong, marginRaw, leverage, liquidated, netPnlRaw, paperMintedRaw]) => ({
    positionId,
    instrumentId,
    isLong,
    marginRaw,
    leverage,
    liquidated,
    netPnlRaw,
    paperMintedRaw,
  }));
export type ClosedPosition = z.infer<typeof ClosedPositionTupleSchema>;

const IntentOutcomeTupleSchema = z
  .tuple([bytes32, z.enum(["succeeded", "failed", "expired", "cancelled", "unknown"])])
  .transform(([intentId, outcome]) => ({ intentId, outcome }));
export type IntentOutcome = z.infer<typeof IntentOutcomeTupleSchema>;

const SessionKeyTupleSchema = z.tuple([address, uint]).transform(([key, expiry]) => ({ key, expiry }));

const FundsSchema = z.object({
  reservedBalance: uint,
  reservedQueued: uint,
  availableBalance: uint,
  availableQueued: uint,
});

const PaperSchema = z.object({ balance: uint, staked: uint, pendingBase: uint, rewardDebt: uint });

const LifetimeSchema = z.object({
  depositedRaw: uint,
  withdrawnRaw: uint,
  realizedPnlRaw: int,
  feesPaidRaw: uint,
  tradedNotionalRaw: uint,
  paperRewardsClaimedRaw: uint,
});

const WalletStateFields = {
  indexedThroughBlock: z.number().int(),
  walletRevision: z.number().int(),
  indexedThroughTimestamp: z.number().int(),
  sessionKeys: z.array(SessionKeyTupleSchema),
  queueRevision: uint,
  balance: uint,
  queued: uint,
  locked: uint,
  funds: FundsSchema,
  queueNodeCount: z.number().int(),
  consumableDebt: uint,
  paper: PaperSchema,
};

export const WalletSnapshotSchema = z.object({
  address,
  accountRevision: z.number().int().positive(),
  ...WalletStateFields,
  lifetime: LifetimeSchema,
  operations: z.array(OperationTupleSchema),
  openPositions: z.array(PositionTupleSchema),
});
export type WalletSnapshot = z.infer<typeof WalletSnapshotSchema>;

export const WalletPatchSchema = z.object({
  address,
  accountRevision: z.number().int().positive(),
  state: z.object(WalletStateFields).partial(),
  lifetime: LifetimeSchema.optional(),
  closedPositions: z.array(ClosedPositionTupleSchema).optional(),
  intentOutcomes: z.array(IntentOutcomeTupleSchema).optional(),
  addedPositions: z.array(PositionTupleSchema),
  removedPositionIds: z.array(uint),
  addedOperations: z.array(OperationTupleSchema),
  removedOperationIds: z.array(bytes32),
});
export type WalletPatch = z.infer<typeof WalletPatchSchema>;

export const SubmitResponseSchema = z.looseObject({
  ok: z.literal(true).optional(),
  action: IntentActionSchema.optional(),
  intentId: bytes32.optional(),
  state: z.string().optional(),
  queueRevision: uint.optional(),
});
export type SubmitResponse = z.infer<typeof SubmitResponseSchema>;

export const DepositCheckSchema = z.object({ proxy: address });

export const HistoryKindSchema = z.enum(["trades", "cashflows", "staking", "queue"]);
export type HistoryKind = z.infer<typeof HistoryKindSchema>;
