import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { createMutex } from "../lib/mutex.js";

export type StoredSessionKey = {
  privateKey: Hex;
  address: Address;
  expiresAtMs: number;
  registeredAtMs: number;
  intentId: Hex | null;
};

export type PersistedState = {
  // Newest first. Older keys stay usable until a replacement is confirmed
  // registered in the wallet snapshot.
  sessionKeys: StoredSessionKey[];
  nonces: Record<string, string>;
  killSwitch: { engaged: boolean; reason: string | null; changedAtMs: number | null };
  daily: { day: string; realizedPnlBaselineRaw: string } | null;
};

export type StateStore = {
  read: () => PersistedState;
  update: (mutate: (state: PersistedState) => PersistedState) => Promise<PersistedState>;
};

const EMPTY: PersistedState = {
  sessionKeys: [],
  nonces: {},
  killSwitch: { engaged: false, reason: null, changedAtMs: null },
  daily: null,
};

// Small JSON file in the data volume, written atomically with 0600 perms
// because it holds the session private key.
export const openStateStore = async (dataDir: string): Promise<StateStore> => {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "state.json");
  const lock = createMutex();
  let state: PersistedState;
  try {
    state = { ...EMPTY, ...(JSON.parse(await readFile(path, "utf8")) as Partial<PersistedState>) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = EMPTY;
  }

  return {
    read: () => state,
    update: (mutate) =>
      lock(async () => {
        const next = mutate(state);
        const tmp = `${path}.tmp`;
        await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(tmp, path);
        state = next;
        return next;
      }),
  };
};

export const createMemoryStateStore = (initial: Partial<PersistedState> = {}): StateStore => {
  let state: PersistedState = { ...EMPTY, ...initial };
  return {
    read: () => state,
    update: async (mutate) => (state = mutate(state)),
  };
};
