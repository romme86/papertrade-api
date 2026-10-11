import { z } from "zod";

// Papertrade fills at Hyperliquid's BBO mid, so HL's book top is the
// execution reference for quotes and dry-run fills.
export type Bbo = { bid: number; ask: number; mid: number; at: number };

export type HyperliquidInfo = {
  bbo: (coin: string) => Promise<Bbo>;
};

const Level = z.object({ px: z.string() });
const L2Book = z.object({ levels: z.tuple([z.array(Level), z.array(Level)]) });

export const createHyperliquidInfo = (infoUrl: string, fetchImpl: typeof fetch = fetch): HyperliquidInfo => ({
  bbo: async (coin) => {
    const response = await fetchImpl(infoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Hyperliquid l2Book ${coin} returned ${response.status}`);
    const { levels } = L2Book.parse(await response.json());
    const bid = Number(levels[0][0]?.px);
    const ask = Number(levels[1][0]?.px);
    if (!(bid > 0 && ask >= bid)) throw new Error(`Hyperliquid ${coin} book is empty or crossed`);
    return { bid, ask, mid: (bid + ask) / 2, at: Date.now() };
  },
});
