# Payments in RQT (design draft)

Status: **draft for review, no code.** Date: 2026-10-10. Scope: how MagnetGate users pay for the full
service in RQT, how people who share their connection (peer exits) earn RQT, and what each project has
to build. Facts about MagnetGate are taken from [README.md](README.md) and [PEER-PILOT.md](PEER-PILOT.md)
at the time of writing. RQT is the coin of [Requant](https://github.com/requant-network/requant).

**Model in one line:** a low-speed tier is always free; the full tier is paid for **by time** in RQT;
peer exits are paid **by the bytes** they carry for paying users, out of those users' own payments.

## 1. Goals and non-goals

Goals:
- Access never disappears: a low-speed tier is free with no time limit. This matters most for people
  behind censorship who cannot pay.
- The full tier is paid in RQT by time (days), with no card and no account beyond the existing
  access code.
- Peer exits earn RQT for the traffic they carry. This is the incentive that brings exits in more
  countries.
- Reuse what exists: MagnetGate's access and quota service and peer catalogue; Requant's public API,
  pool-style batch payouts and the 0.15.0 channel primitives.

Non-goals:
- No MagnetGate inside the Requant node and no MagnetGate advertisement in Requant's peer-to-peer
  network. Requant node addresses are public, so exits co-located with nodes could be listed and
  blocked.
- No consensus change and no share of the block reward for MagnetGate. Service delivery cannot be
  verified on chain.
- No automatic payment from the development fund per megabyte. It could be farmed by routing one's
  own traffic through one's own exit.
- No custody of user keys.

## 1a. Open source first: everything works without payments

MagnetGate is an open-source project. Anyone who builds it and runs it for themselves must get a
complete VPN with no Requant, no wallet and no payment service. Payments are one optional feature of
one deployment, the operator's public service, and not part of the core.

- **Off unless the service says otherwise.** The access service has `payments.enabled` in its
  settings, off by default. When it is off, the paid tier, deposits, payouts and every RQT code path
  stay inactive. The free tier then has whatever limits the deployer sets: today's behaviour.
- **Clients show what the service advertises.** `/api/info` lists `payments` only when they are on.
  The wallet tab, "Get full access" and payout settings appear only then. With no such field (an older
  or self-hosted service, the private group (PSK) mode, the peer pilot without payments), the app looks
  and works as it does today, and the wallet never opens and never contacts a Requant API.
- **Nothing tied to our deployment.**
  - Deposit addresses come from the deployer's own seed; prices, discounts and the exit share come
    from their own admin panel.
  - The client must not hard-code our hosts. Today `magnet.norma.so` is fixed in the desktop and
    Android personal-access code and the countries are limited to FI/NL. A self-hosted public service
    needs these to be configurable (a service URL entered with the code, or a build setting). That is
    work in its own right.
- **Separable code.** Payment and wallet code lives in its own modules (`payments/` server side; a
  wallet module in each client) behind the `payments` switch and a build flag. A fork can build without
  them, as the app-store variant without a wallet already needs (§6).
- **The private group mode never charges.** A PSK group (your own exits, Mainline DHT + Nostr
  discovery) has no payment code path at all, with or without the switch.
- **Peer exits** in someone else's deployment are not paid unless that deployment turns payments on
  with its own seed.

## 2. MagnetGate today (what this builds on)

- **Personal public access.** A personal `MG1-…` code is issued after human verification. It lasts
  30 days, allows 2 devices and gives 5 GiB a day at up to 20 Mbit/s. Traffic goes over Hysteria2 to
  operator nodes in Finland and the Netherlands. A centralized access and quota service accounts
  traffic periodically.
- **Peer pilot.** Users can connect through another user's exit, chosen from a country catalogue,
  through an operator-run authenticated catalogue/relay. Only TCP 80/443 is carried. Exits are opt-in
  on Windows, Linux and Android, with default sharing quotas of 1 GiB a day and 20 GiB a month.
- **Clients.** Desktop is Electron/Node.js; Android is a native app with a Go core.

The operator already authenticates clients, meters traffic and runs the relay. Payments can
therefore start **through the operator**. Trust-minimised channels between client and exit come
later, if the network decentralises beyond the operator (phase 3).

## 3. Tiers and the user journey

| | Free (always) | Full (paid in RQT) |
|---|---|---|
| Code | 7 days, renewed by passing the human check again | Valid while paid days last (at least 7 days) |
| Speed | 2–3 Mbit/s: messengers, sites, voice calls | No speed limit |
| Volume | No daily cap by default (at 3 Mbit/s one code moves at most ≈32 GiB a day); the global budget stays | No limit |
| Where | Operator nodes | Operator nodes and peer-exit countries |
| Devices | 2 per code | 2 per code |

Every number here is a parameter in the website's admin panel (§9). The free tier uses the existing
personal code, its human verification and the global traffic budget. Because a new code gives the same
low speed, re-registering gains nothing. The only abuse left is running many codes in parallel to add
up speed, and the existing registration limits bound it. Free traffic is carried by operator nodes;
exits are not paid for it.

1. **Start free** with a code, at low speed, for as long as needed.
2. **Get RQT** to unlock the full tier:
   - **buy** from the fund's market maker or **swap** (XMR, BTC and others; see [Requant SWAPS.md](https://github.com/requant-network/requant/blob/main/SWAPS.md)), the main path;
   - **mine**, but only with an NVIDIA GPU (RTX 20xx or newer); most phone and laptop users cannot;
   - **earn by sharing**: run a peer exit and get paid (phase 2).
3. **Pay** by topping up a prepaid balance (phase 1). The app shows the deposit address and the days
   of full access left.
4. **Use** the full tier until the days run out; the code then falls back to the free tier, it is not
   cut off.

## 4. Phase 1: prepaid access to operator nodes

The simplest working version needs no channels and no wallet in the app.

- **Deposit addresses.** Each access account gets its own RQT deposit address. Requant transfers have
  no memo field, so one address per account is how a payment is attributed. The service holds no keys:
  the operator makes a list of addresses offline with `requant-wallet newaddress WALLET --count N --out
  deposits.txt` and gives the service only that file. An address goes to one account and is never
  handed out again. The operator sweeps the coins with the wallet that made the list (`prepare` on a
  watch-only copy, `sign` offline, `broadcast`); `restore --count N` brings the whole list back from the
  backup phrase.
- **Watching.** The access service polls a Requant node's public API (`/api/history?owners=`), best
  the operator's own `requantd`. It credits a deposit after N confirmations, once per (txid, address). Proposed N is 6 on the test network;
  for value, scale it with the amount and the network hashrate ([Requant SWAPS.md](https://github.com/requant-network/requant/blob/main/SWAPS.md), Finality).
- **Crediting.** A confirmed deposit buys days of full access, added to any days left, from one day up.
  Longer purchases are cheaper per day: the price of `d` days is
  `d × price_atoms_per_day × (1 − discount(d))`, where `discount` is a step table in the admin panel
  (for example 0% for 1–6 days, 10% from 7, 20% from 30, 30% from 90). The deposited amount buys the
  largest whole number of days it covers at the discount that number reaches. The remainder stays on
  the account and counts towards the next purchase.
- **Code lifetime.** Paid days keep the code valid until they run out. Then the code is a free one
  again, with its usual 7-day renewal.
- **Enforcement.** The access service switches the code between the free and full limits, as it
  enforces limits today. Its approximate periodic accounting is enough, because users are charged by
  time, not by bytes.
- **No refunds on chain** in phase 1. Unused prepaid balance stays on the account (still open, §9).
- **The app** shows the deposit address (and QR), the confirmed and pending balance and the days of
  full access left, all from the access service. Paying from any Requant wallet works; an in-app wallet
  (§6) is a convenience, not a requirement.

The risk is small and centralised. The operator holds the deposits, and users trust the operator as
they already do for access. With the deposit list made offline, the server itself holds nothing that
can spend them.

### 4.1 Status: the access service side is implemented

`web/payments.py` and `web/server.py` (branch `feat/payments-phase1`, not deployed):

- `payments` in the settings, off unless `enabled` is `true`:

  ```json
  "codeLifetimeDays": 7,
  "payments": {
    "enabled": true,
    "network": "test",
    "api": "http://127.0.0.1:19380",
    "depositList": "/etc/magnetgate-public/deposits.txt",
    "priceAtomsPerDay": 10000000,
    "discounts": [[7, 10], [30, 20], [90, 30]],
    "confirmations": 6
  }
  ```

  The service refuses to start if a setting is invalid or any line of the deposit list is not an
  address of that network. `codeLifetimeDays` (default 30, today's lifetime) applies with or without
  payments.
- `/api/info` carries `payments` (currency, network, price, discounts, confirmations) only when they
  are on. `POST /api/payment {code}` hands the account its deposit address on the first ask and
  returns the tier, the paid-until time, the code's expiry, the balance left and the recent credits.
- A background thread polls the watched addresses (those handed to accounts that still exist) every
  `pollSeconds` (60), 25 per request, within the node API's rate limit.
- A credit adds the most days the balance plus the deposit buys (§9 discounts) and keeps the rest.
  The code then stays valid until the paid days end plus one free code lifetime, to top up with the
  same code. An account with RQT left over is not cleaned up.
- During paid days the per-account daily quota does not apply. `/api/profile` returns `tier` and gives
  a node's `fullEndpoint` instead of its `endpoint` when the node has one. `/api/node-auth` takes an
  optional `listener` (`free` or `full`); the `full` listener admits paid accounts only.

**Nodes** (`web/node_agent.py`). A node without `listeners` in its agent config works as today: one
Hysteria2 instance, auth at `/auth`. A node with the two tiers runs two instances, the free one with
Hysteria2's per-client `bandwidth` limit:

```yaml
# free: hysteria-free.yaml                     # full: hysteria-full.yaml
listen: :443                                   # listen: :8443
bandwidth: {up: 3 mbps, down: 3 mbps}          # (no bandwidth limit)
auth:
  type: http
  http: {url: http://127.0.0.1:3411/auth/free} #   url: http://127.0.0.1:3411/auth/full
trafficStats: {listen: 127.0.0.1:3412, secret: <free secret>}   # 127.0.0.1:3413, <full secret>
```

```json
"listeners": [
  {"name": "free", "pidFile": "/run/magnetgate-public/hysteria.pid", "statsPort": 3412, "statsSecret": "..."},
  {"name": "full", "pidFile": "/run/magnetgate-public/hysteria-full.pid", "statsPort": 3413, "statsSecret": "..."}
]
```

The agent passes the listener's name to `/api/node-auth`, sums online counts over both instances and
reports their traffic as one counter, so a restart of either instance adds only its new traffic. In
the service's `nodes`, such a node gets `fullEndpoint` (the 8443 endpoint) next to `endpoint`.

Not done yet: the payment screen in the apps, admin-panel editing of these parameters, and English for
the service's older error messages.

## 5. Phase 2: peer exits earn RQT

- **Metering.** Peer traffic already passes through the operator's authenticated relay, which counts
  bytes per exit. That count is the basis for payment; exits do not report their own traffic.
- **Sold by time, credited by gigabytes, from each user's own payment.** Users pay by time, but an
  exit's real cost is bandwidth (mobile data on Android), so exits are credited by gigabytes. A share of
  each paying user's payment for a day (`exit_share`, 50% to start, set in the admin panel) goes to the
  exits **that user** used that day, in proportion to that user's gigabytes through each. The rest
  goes to the operator. The payment for a day of a multi-day purchase is its discounted per-day price.
- **Why per user, not one common pot.** With a fixed daily price and one pot shared by bytes, an exit
  could buy one day, push as much traffic as possible through its own exit and take other users'
  money out of the pot. With per-user allocation, a self-dealer gets back only their own payment minus
  the operator's share, so self-dealing loses money. Honest exits are paid exactly for what they
  carried for paying users.
- **Payouts.** Exits register a payout address and are paid in batches on chain, every N blocks above
  a minimum: the same mechanism as the Requant pool's PPLNS payouts. One transaction pays many exits.
- **Consent and limits.** This keeps the pilot's rules: opt-in hosting, a persistent stop, user-set
  speed and volume limits, a pause on network changes, and only TCP 80/443 until UDP is reviewed.
  Payment does not change what an exit carries, only that it is paid for it.
- **New countries.** The catalogue can show a price per country. Optional, manually approved,
  time-limited **grants** from the development fund can help the first exits in a missing country
  (§7).

## 6. In-app wallet (optional in phase 1, useful in phase 2)

- **Function:** a light wallet with an address, a balance, paying a deposit or plan, receiving exit
  payouts, and a backup. It has no node of its own.
- **Backend.** It uses Requant's public API (`/api/...`, node 0.14.0+), and **only through the
  MagnetGate tunnel itself**. Then the API node never sees the user's IP, and blocking the API's
  address in a censoring country does not cut the wallet off.
- **Keys** stay on the device, with a fresh address per payment or payout.
- **Code reuse.** Desktop (Electron) can load the WASM core of `requant-wallet-extension`, which
  already signs locally against the pinned consensus. Android (Go core) can embed the same WASM
  through a Go WASM runtime, or bind the Rust `wallet-core` of `requant-wallet` through JNI.
- **Backup: an encrypted key file** (decided). It is the format of `requant-wallet`, the browser
  extension and the Requant CLI's single-key files (`requant-key:1:argon2id…`), so funds can move
  between all of them. One key file is one address. That is enough for paying deposits and receiving
  exit payouts, but it reuses one address. Exits that want unlinkable payouts can register a fresh key
  file now and then. Phase 3 channels need fresh keys per channel and will derive them separately.
- **App stores.** A crypto wallet inside a VPN app adds review and regional requirements. A build
  variant without the wallet (pay from an external wallet via the deposit address) keeps the app
  distributable where that matters.

## 6a. The client app: language, wallet and choosing a route

Today desktop labels are Russian, and Android has RU/EN with the newer panels in Russian. Personal
access, the peer pilot and the private group are separate screens. With a paid tier, a wallet and peer
countries, the app needs one clear flow.

- **English by default.** All UI strings move to one translation catalogue, with English as the
  default and fallback and Russian as the second language. The language follows the system, with a
  manual switch in settings. Website, desktop and Android share string keys where they show the same
  thing (tiers, prices, errors).
- **Wallet tab** (§6). It shows:
  - the balance and the days of full access left;
  - "Get full access": buy days, with the discount table shown; pay from the in-app key or show the
    deposit address and QR for another wallet;
  - receiving exit payouts (when the user shares);
  - backup and restore of the encrypted key file.
- **One country picker for every route.** One searchable list of countries; each country shows where
  its traffic would go:
  - **Operator** nodes: MagnetGate's own servers (Finland, the Netherlands). TCP and UDP; both tiers.
  - **Private** exits: other users sharing their connection. More countries; TCP 80/443 only for
    now; full tier only (`peer_countries_full_only`).
  - Per country it shows availability, the number of exits for private ones, the expected speed for the
    user's tier, and the supported traffic (UDP or not), so that the user knows before connecting
    whether video calls will work.
- **Route choice.** A switch with three settings: **Automatic** (operator nodes first, private exits
  when the country is only available there), **Operator only** and **Private only**. A country that
  is not available in the chosen mode stays visible and greyed out, with the reason. It never silently
  becomes another country, which the peer pilot already guarantees.
- **Tier gating in place.** Choosing a private country or more speed on the free tier opens "Get full
  access" right there. A connection that falls back from full to free (days ran out) says so.
- **Sharing (earning).** The existing opt-in "allow others to use my connection" moves next to the
  wallet, with its limits and with what has been earned so far.

## 7. The development fund (6%)

The fund receives 6% of the block reward for heights 1..2^21. At the test network's current reward
of about 4 RQT a block, that is about 0.24 RQT a block, or about 345 RQT a day. The fund is an
ordinary key, so the uses below need no consensus change. **Decided: used as needed**, case by case
and by hand. Nothing below runs automatically.

| Use | Why it is safe | Limits |
|---|---|---|
| **Market maker:** sell RQT for XMR/BTC/USDT through swaps | Users get a way to buy RQT; the fund gives nothing away | Pricing policy; legal review of selling coins (§10) |
| **Grants** to the first exits in missing countries | Manual, named and time-limited | A budget per month; published |
| **A free-tier pool**, if the operator wants to pay exits for some free traffic | Capped per day; metered by the relay | Off by default; easy to farm otherwise |

What is not proposed: automatic per-megabyte payments from the fund.

## 8. Phase 3 (later): channels between client and exit

Phase 3 matters only if exits and clients should not have to trust the operator with money, for
example if peer discovery moves off the operator's relay. It uses the one-way channel already
proven in Requant's consensus tests ([`one_way_payment_channel`](https://github.com/requant-network/requant/blob/main/crates/consensus/tests/conditions.rs); [Requant SWAPS.md](https://github.com/requant-network/requant/blob/main/SWAPS.md) §3):

1. The client locks a deposit under 2-of-2 (client, exit), with fresh keys for each channel.
2. The exit signs a refund to the client that is valid from an expiry height (for example 7 days,
   10,080 blocks), and the client keeps it.
3. The client pays **after delivery**, by time: every minute it signs a new state paying the exit for
   the minute served. The exit risks at most one unpaid minute; the client risks nothing beyond it.
   Paying by time also spares the exit from counting bytes itself.
4. The exit closes with the last state well before the expiry. If it misses the expiry, the client
   can take the refund, so the exit must monitor its channels.

Work this needs first:
- a shared Rust channel library in the Requant repository, with bindings for the apps;
- child-pays-for-parent in the pool, because state and refund fees are fixed when signed;
- a way to bound what an exit must carry per paid minute (a speed cap agreed when the channel opens),
  since there is no operator relay to meter it.

## 9. Decisions and admin parameters

Decided (2026-10-10):
- The free tier is always available at 2–3 Mbit/s.
- The full tier has no limits and is sold from one day, with a discount that grows with the number of
  days bought.
- Codes last 7 days.
- Exits get 50% to start.
- The in-app wallet keeps an encrypted key file.
- The development fund is used as needed.

All numbers are **parameters in the website's admin panel**, not constants in code:

| Parameter | Start value | Notes |
|---|---|---|
| `free_speed_mbit` | 3 (range 2–3) | Per code, both directions |
| `free_daily_cap_gib` | off | Optional; the global traffic budget stays in any case |
| `code_lifetime_days` | 7 | Free codes; renewed by passing the human check again |
| `devices_per_code` | 2 | Both tiers |
| `price_atoms_per_day` | to be set (test RQT on the test network) | Full tier, before discount |
| `discount` table | 0% 1–6 days, 10% from 7, 20% from 30, 30% from 90 | Step table: days from → percent |
| `exit_share` | 50% | Of each paying user's per-day payment, split by that user's gigabytes |
| `deposit_confirmations` | 6 | Raise with amounts and network hashrate |
| `payout_interval_blocks` / `payout_min_atoms` | for example 1440 / 1 RQT | Batch payouts to exits |
| `peer_countries_full_only` | yes | Peer-exit countries for the full tier only |

**Admin panel security.** The panel is read-only today: no public authentication, bound to
`127.0.0.1`, reached over SSH forwarding, with Host/Origin checks. Editing parameters keeps that
boundary:
- writes are accepted only through the same local-only panel;
- each value is validated against its allowed range;
- every change is logged (who, when, old value, new value) in the panel's own history database.

The public website and the access service **read** the parameters and never write them. Public login
or SSO for the panel would need its own design ([web/ADMIN.md](web/ADMIN.md)).

Still open:
- refund policy for unused balance (default: it stays on the account, no on-chain refunds);
- the price per day on the main network.

## 10. Risks to state plainly

- **Test coins have no value.** On the test network all of this is a pilot. Real prices need the
  main network.
- **Legal.** Selling VPN access for crypto, paying exit operators (who may then be seen as running
  a communications service) and a fund that sells coins each carry legal questions that depend on
  the jurisdiction. They need a review before real value.
- **Linkability.** The operator links accounts to deposit addresses, as it links accounts to traffic
  totals today. Payments from an exchange account link the user's identity to the deposit. Swaps
  from XMR avoid that. Batched exit payouts reveal payout addresses and amounts on chain, so exits
  should use fresh payout addresses.
- **Hot wallet.** Phase 1 and 2 deposits and payouts sit on the operator's server. Keep them on a
  machine separate from Requant seed nodes and from the faucet and pool keys, with small balances
  and regular sweeps to cold storage.
- **Finality.** Credit deposits only after confirmations proportionate to the amount ([Requant SWAPS.md](https://github.com/requant-network/requant/blob/main/SWAPS.md)).

## 11. Work split

| | Requant | MagnetGate |
|---|---|---|
| Phase 1 | Done: public API (200 owners per request from node 0.15.2), RPC `history`/`utxos`, HD derivation and deposit lists (`newaddress --count`, `restore --count`, wallet 0.4.1) in `requant-wallet` | Done (§4.1): deposits, crediting and days of full access in the access service. Open: free/full listeners and the free speed limit on the nodes; deposit address and days left in the app |
| Phase 2 | Generalise the pool's batch payout code into a payout service | Per-user, per-exit byte counts from the relay; per-user allocation of each payment; payout addresses; catalogue of paid countries |
| Wallet | WASM/JNI bindings of the existing wallet cores | Wallet UI, tunnel-only API access, build variant without the wallet |
| App | — | English by default with a shared RU/EN catalogue; unified country picker with operator/private routes and per-country capabilities; tier gating |
| Self-hosting | — | `payments.enabled` switch (off by default) and a `payments` field in `/api/info`; clients hide all payment UI without it; a configurable personal-access service URL instead of the fixed host; payment and wallet code in separable modules behind a build flag |
| Phase 3 | Channel library, CPFP pool policy | Exit-side metering, channel UI |

Suggested order:
1. Phase 1 on the test network with test RQT from the faucet: deposits, crediting, a paid tier.
2. Phase 2 with a few peer exits: metering-based payouts.
3. The wallet in the app.
4. Phase 3, only if needed.
