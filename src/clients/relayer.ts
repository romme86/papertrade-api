import type { Hex } from "viem";
import { SubmitResponseSchema, type IntentAction, type SubmitResponse } from "../protocol/schemas.js";
import type { SignedIntent } from "../protocol/signing.js";
import type { PapertradeHttp } from "./http.js";

export type Relayer = {
  submit: (action: IntentAction, signed: SignedIntent) => Promise<SubmitResponse>;
  cancel: (intentId: Hex, signedWithoutId: Omit<SignedIntent, "intentId">) => Promise<unknown>;
};

export const createRelayer = (http: PapertradeHttp): Relayer => ({
  submit: async (action, signed) => SubmitResponseSchema.parse(await http.post("/intents", { action, signed }, { timeoutMs: 20_000 })),
  cancel: (intentId, signedWithoutId) => http.post(`/intents/${intentId}/cancel`, signedWithoutId, { timeoutMs: 20_000 }),
});
