import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { jsonReplacer } from "../lib/logger.js";

// Append-only JSONL record of every live write: what was signed, what the
// relayer answered. Only submitted intents are logged with signatures.
export type AuditLog = {
  write: (entry: Record<string, unknown>) => Promise<void>;
};

export const openAuditLog = async (dataDir: string): Promise<AuditLog> => {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "audit.jsonl");
  return {
    write: (entry) => appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry }, jsonReplacer)}\n`, { mode: 0o600 }),
  };
};

export const memoryAuditLog = (sink: Record<string, unknown>[] = []): AuditLog => ({
  write: async (entry) => {
    sink.push(entry);
  },
});
