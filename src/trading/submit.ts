import type { Hex } from "viem";
import type { Relayer } from "../clients/relayer.js";
import type { Logger } from "../lib/logger.js";
import type { IntentAction } from "../protocol/schemas.js";
import type { SignedIntentResult } from "../protocol/signing.js";
import type { AuditLog } from "../state/audit.js";

export type Submission = {
  intentId: Hex;
  localIntentId: Hex;
  state: string | null;
  response: unknown;
};

export type Submit = (action: IntentAction, result: SignedIntentResult, context: Record<string, unknown>) => Promise<Submission>;

// Every signed write goes through here: audited before it leaves, and again
// with the relayer's answer or refusal.
export const createSubmitter = (deps: { relayer: Relayer; audit: AuditLog; logger: Logger }): Submit => async (action, result, context) => {
  await deps.audit.write({ event: "submit", action, intentId: result.intentId, signed: result.signed, ...context });
  try {
    const response = await deps.relayer.submit(action, result.signed);
    const intentId = response.intentId ?? result.intentId;
    if (response.intentId && response.intentId !== result.intentId) {
      deps.logger.warn("relayer intent id differs from local derivation", { local: result.intentId, relayer: response.intentId });
    }
    await deps.audit.write({ event: "accepted", action, intentId, response });
    return { intentId, localIntentId: result.intentId, state: response.state ?? null, response };
  } catch (error) {
    await deps.audit.write({ event: "rejected", action, intentId: result.intentId, error });
    throw error;
  }
};
