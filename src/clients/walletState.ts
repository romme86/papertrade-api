import type { Hex } from "viem";
import type { ClosedPosition, IntentOutcome, WalletPatch, WalletSnapshot } from "../protocol/schemas.js";

// Pure reducer for the /state/user/live stream: a full snapshot first,
// then incremental patches keyed by accountRevision.
export type WalletState = WalletSnapshot;

export const applyWalletPatch = (current: WalletState, patch: WalletPatch): WalletState => {
  if (patch.accountRevision <= current.accountRevision) return current;

  const positions = new Map(current.openPositions.map((p) => [p.positionId, p]));
  for (const id of patch.removedPositionIds) positions.delete(id);
  for (const position of patch.addedPositions) positions.set(position.positionId, position);

  const operations = new Map(current.operations.map((o) => [o.intentId, o]));
  for (const id of patch.removedOperationIds) operations.delete(id);
  for (const operation of patch.addedOperations) operations.set(operation.intentId, operation);

  return {
    ...current,
    ...patch.state,
    accountRevision: patch.accountRevision,
    lifetime: patch.lifetime ?? current.lifetime,
    openPositions: [...positions.values()],
    operations: [...operations.values()],
  };
};

// Bounded memory of how submitted intents ended and which positions closed.
export type OutcomeLog = {
  record: (patch: WalletPatch) => void;
  intent: (intentId: Hex) => IntentOutcome | undefined;
  closed: (positionId: bigint) => ClosedPosition | undefined;
  recentClosed: () => ClosedPosition[];
};

export const createOutcomeLog = (capacity = 500): OutcomeLog => {
  const intents = new Map<Hex, IntentOutcome>();
  const closed = new Map<bigint, ClosedPosition>();
  const trim = <K, V>(map: Map<K, V>) => {
    while (map.size > capacity) map.delete(map.keys().next().value as K);
  };
  return {
    record: (patch) => {
      for (const outcome of patch.intentOutcomes ?? []) intents.set(outcome.intentId, outcome);
      for (const position of patch.closedPositions ?? []) closed.set(position.positionId, position);
      trim(intents);
      trim(closed);
    },
    intent: (intentId) => intents.get(intentId.toLowerCase() as Hex),
    closed: (positionId) => closed.get(positionId),
    recentClosed: () => [...closed.values()].reverse(),
  };
};
