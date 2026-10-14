# papertrade-api

A small standalone HTTP service that reads from and trades on
[papertrade.xyz](https://papertrade.xyz) (synthetic perps on Hyperliquid's
HyperEVM) programmatically. It has no strategy logic: callers such as
Cassandrina decide what to trade, and this service does the reading, signing,
risk checks and submission.

> **Papertrade is real money.** Despite the name, positions are funded with real
> USDC and settle against a shared LP. Winning *profits* can be queued if the LP
> is short (your margin is always returned immediately).

## How it talks to Papertrade

Papertrade has no documented trading API. Its relayer accepts the same signed
EIP-712 "intents" its own frontend produces, and this service mirrors that
frontend exactly (read from the public bundle, build `f318d7d811da`, 2026-10-11).

| Concern | Mechanism |
| --- | --- |
| Market / protocol state | `GET /state/trading`, `/query/protocol/*`, `/relayer/health` |
| Account state | SSE stream `GET /state/user/live?wallet=…` (snapshot + patches) |
| Open / close / cancel | `POST /intents` `{action, signed}` signed by a **session key** |
| Session key | `RegisterSessionKey` signed by the **wallet**, 30-day expiry, auto-renewed |
| Prices | Hyperliquid `l2Book` best bid/ask; Papertrade fills at their mid |
| Deposits | Per-user CREATE2 proxy (`/funding/deposits/check`, cross-checked on-chain) |

Key facts baked into the guards: positions need **≥ $10,000 notional**
(margin × leverage) and ≥ $10 margin; max 1000×; BTC and ETH only; positions
can't be resized (close and reopen); liquidation forfeits the **full** margin,
about 5 bps before zero equity.

## Safety model

- **Dry-run by default.** `LIVE_TRADING=false` makes every write a dry-run:
  the intent is built and signed with a *throwaway* key and random nonce, then
  returned unsigned. Nothing that could be replayed on your account is produced.
  A request can always ask for `dryRun: true`; it can never force live.
- **Two keys.** The wallet key (in `.env`) signs session-key registrations and
  PAPER stake / unstake / claim (Papertrade only accepts those from the wallet).
  Trades are signed by the session key (in the data volume), which Papertrade
  allows to open/close but **not withdraw**.
- **Guards before signing**: Papertrade's own limits plus `MAX_MARGIN_USD`,
  `MAX_LEVERAGE`, `MAX_OPEN_POSITIONS`, `MAX_TOTAL_MARGIN_USD`,
  `DAILY_LOSS_LIMIT_USD`, snapshot freshness and session validity.
- **Margin caps grow with profit**: the per-trade cap is `MAX_MARGIN_USD` plus
  the account's lifetime realised profit, and the total cap is
  `MAX_TOTAL_MARGIN_USD` plus the same profit. Callers can compound winnings,
  but losses never lower the caps below the configured base.
  `/v1/limits` (and `limits` in `/v1/account`) shows the caps in force.
- **Kill switch** blocks opens (closes still work), persisted across restarts.
- **Audit log** (`/data/audit.jsonl`) of every live submission and response.
- Writes are serialised, so nonces and guard checks never interleave.
- Withdrawals are **not implemented** yet.

## API

All `/v1` routes need `Authorization: Bearer $API_TOKEN`. Amounts are USD
strings (preferred) or numbers; responses carry raw 18-decimal values as strings.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, mode, snapshot age (no auth) |
| GET | `/v1/markets` | BTC/ETH params, minimums, impact curve, OI, HL BBO |
| GET | `/v1/account` | Balances, lifetime PnL/fees, PAPER + staking rewards, live caps, pending intents, session |
| GET | `/v1/limits` | Margin caps in force (base + realised profit) and the other limits |
| GET | `/v1/positions` | Open positions with entry, bust, mark, est. close PnL |
| GET | `/v1/positions/closed` | Recently closed positions seen on the stream |
| GET | `/v1/history/:kind` | `trades` \| `cashflows` \| `queue` \| `staking` (`?cursor=`) |
| GET | `/v1/intents/:id` | Status of a submitted intent |
| GET | `/v1/protocol` | LP / queue / relayer health / notices |
| POST | `/v1/quote` | Notional, bust price, keep-fraction curve, scenario |
| POST | `/v1/orders/open` | `{market, side, marginUsd, leverage, dryRun?}` |
| POST | `/v1/orders/close` | `{positionIds: [...], dryRun?}` (12 per intent) |
| POST | `/v1/orders/close-all` | `{dryRun?}` |
| POST | `/v1/intents/:id/cancel` | Cancel a queued intent |
| GET/POST | `/v1/session`, `/v1/session/register` | Session-key status / register now |
| GET/POST | `/v1/kill-switch` | `{engaged, reason?}` |
| GET | `/v1/funding/deposit-address` | Where to send USDC on Hyperliquid |
| GET | `/v1/paper` | PAPER balance / staked, claimable + claimed USDC rewards, minimum stake |
| POST | `/v1/paper/stake` | `{amount?: "all" \| "<PAPER>", dryRun?}` (Papertrade minimum 1,000 PAPER per stake) |
| POST | `/v1/paper/unstake` | `{amount?: "all" \| "<PAPER>", dryRun?}` (instant, no lockup) |
| POST | `/v1/paper/claim` | `{dryRun?}` moves claimable USDC rewards into the trading balance |
| GET | `/v1/candles` | Stored 1-minute history per source and coin, and sync status |
| GET | `/v1/candles/:source/:coin` | `?from=&to=` (epoch ms or ISO) minute columns, at most 7 days per call |
| GET | `/v1/candles/:source/:coin/days/:day` | One stored UTC day (`YYYY-MM-DD` or day number) as raw float64 bytes |
| GET | `/v1/funding-rates/:coin` | `?from=&to=` Binance perp funding settlements |

Example (dry-run, or live when `LIVE_TRADING=true`):

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -X POST http://papertrade-api:8787/v1/orders/open \
  -d '{"market":"BTC","side":"long","marginUsd":"100","leverage":100}'
```

Live opens return `202` with `submission.intentId`; poll `/v1/intents/:id` or
`/v1/positions`. Guard failures return `422` with `error.violations[]`.

## Historical 1-minute candles

A background sync keeps 1-minute BTC and ETH candles from two sources in the
data volume:

| Source | What | History |
| --- | --- | --- |
| `binance` | USDⓈ-M `BTCUSDT` / `ETHUSDT` perps, the candles Cassandrina's backtests and the weekend-fade feed use | Backfilled `CANDLE_BACKFILL_DAYS` (766 = 2 years + 36 days of look-back) on first start. Past months come from the public monthly archives on `data.binance.vision` and the current month from the REST API. Funding is stored as well. |
| `hyperliquid` | Hyperliquid perp candles. Papertrade fills at Hyperliquid's mid, so these are the execution reference. | HL keeps only about the newest 5000 minutes (~3.5 days), so this history starts about 3.5 days before the first sync and grows from there. |

Both are topped up every `CANDLE_POLL_SECONDS` and funding every hour. Nothing
is ever pruned. The store adds about 50 MB a year per source for both coins.

Storage uses the same layout as Cassandrina's backtest day blocks:
`/data/candles/<source>/<coin>/<utcDay>.f64` is 1440 minutes ×
`[open, high, low, close, volume, takerBuy]` as float64 little-endian
(minute-major, `NaN` = no candle; Hyperliquid has no `takerBuy`). The
`index.json` next to the blocks records each day's synced and filled minutes.
`/v1/candles/:source/:coin/days/:day` serves a block byte for byte. The
`X-Synced-Minutes` / `X-Filled-Minutes` headers tell a partial day apart from a
complete one.

```bash
# columns for one hour; null = no candle (or not synced yet)
curl -s -H "Authorization: Bearer $API_TOKEN" \
  "http://papertrade-api:8787/v1/candles/binance/BTC?from=2026-10-14T12:00:00Z&to=2026-10-14T13:00:00Z"
```

The column response has `from`, `to`, `length`, `syncedThrough` and
`columns.{open,high,low,close,volume,takerBuy}`. Ranges longer than 7 days come
back `truncated: true`; continue with `from` = the returned `to`. Archive months
are streamed (download → inflate → parse → day blocks), so the backfill fits
inside the container's 256 MB limit.

## Going live (operator checklist)

1. Deploy in dry-run and check `/v1/markets`, `/v1/account`, a dry-run open.
2. `GET /v1/funding/deposit-address`, confirm `matchesRelayer: true`, then send
   USDC **from Hyperliquid** to that address yourself (≥ 10 USDC arrives; the first
   deposit pays a 1 USDC activation fee). Wait for `/v1/account` to show it.
3. `POST /v1/session/register`, then confirm `/v1/session` shows an `activeKey`.
   This is the first signed write. If the relayer rejects it, the error body says why.
4. Set `LIVE_TRADING=true`, restart, and place the first small trade yourself.
   Check that `submission.intentId` equals `localIntentId`. A mismatch is logged
   and means the intent-id derivation changed upstream.

## Development

```bash
npm install
npm test            # vitest, no network
npm run typecheck
npm run dev         # needs a .env with at least WALLET_PRIVATE_KEY and API_TOKEN
```

## Deployment (Geekom Proxmox, dedicated VM)

1. On the Proxmox host: `sudo ./infra/proxmox-create-vm.sh` (VMID 102, 2 vCPU, 1 GB with a 512 MB balloon floor, 20 GB).
2. On the VM: `sudo ./infra/vm-bootstrap.sh`, then follow its printed steps.
   Reached over the home LAN instead of Tailscale: run the bootstrap with
   `WITH_TAILSCALE=false`, set `BIND_ADDRESS` to the VM's LAN IP and allow only
   the caller: `sudo ALLOW_FROM=<caller LAN IP> ./infra/lan-allowlist.sh install`
   (Docker bypasses ufw, so the rule lives in Docker's `DOCKER-USER` chain).
   Reserve both VMs' IPs in the router's DHCP so they cannot change.
   Both VMs on the same Proxmox host (the current setup): give each a second NIC on
   an isolated bridge with no uplink (`vmbr1`, 10.20.0.0/24, static addresses in
   `/etc/systemd/network/60-private-link.network`), bind to the papertrade VM's
   10.20.0.2 and run the allowlist with `ALLOW_FROM=10.20.0.1`. Nothing on the LAN
   can reach the API, and no router setting is involved.
3. Updates: push to `main`, then on the VM:

```bash
cd ~/papertrade-api && git pull --ff-only && docker compose --env-file /home/papertrade/papertrade-api/.env up -d --build
```

Always pass `--env-file` explicitly. Back up the `papertrade-data` volume:
it holds the session key, nonce counters and audit log. Losing its `candles/`
folder only costs a re-sync, except for Hyperliquid minutes older than ~3.5 days.

## Known unknowns

- The relayer protocol is undocumented and can change with any frontend deploy.
  The build id is rediscovered every 30 min, and stale-build errors trigger a refresh.
- The exchange EIP-712 domain name is literally `"String"` in the frontend; kept verbatim.
- OI raw units are not documented; they are exposed unparsed.
