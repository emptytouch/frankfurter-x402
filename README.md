# Frankfurter Exchange Rates + Conversion (x402 on Kite)

Wraps the free, open-source [Frankfurter](https://frankfurter.dev) exchange-rate
API as an x402 service on the Kite chain, and adds a **server-computed currency
conversion** endpoint. Built from the official `typescript-express` x402 template,
then extended well past the stock wrapper.

| | |
|---|---|
| `GET /v1/latest` | latest reference rates → `https://api.frankfurter.dev/v1/latest` |
| `GET /v1/{YYYY-MM-DD}` | one historical day, e.g. `/v1/2024-01-02` |
| `GET /v1/{START}..{END}` | time series over a date range, e.g. `/v1/2024-01-01..2024-01-31` |
| `GET /v1/convert` | **computed** conversion, e.g. `/v1/convert?from=USD&to=CNY&amount=100` |
| Price | `latest` + single day **$0.001**; time series + `convert` **$0.01** (pieUSD, Kite testnet `eip155:2368`) |
| Upstream auth | none (Frankfurter is free & keyless) |
| Deployed | `status: testnet` — https://frankfurter-x402.onrender.com |
| Paid proof | see `PROOF.md` |

## Why this is more than a `.env`-only wrapper

Frankfurter requires its `/v1` prefix, so the stock template's "strip `/v1`"
contract would 404 every paid request. We forward the request path unchanged
(`src/index.ts` → `proxyRequest`). On top of that plumbing, this service adds
four production layers the stock template lacks:

1. **Tiered pricing** — a single snapshot is cheap; a multi-day series (far
   larger payload) and the server-computed `convert` are premium. The split
   reflects *value*, not upstream cost (Frankfurter is free).
2. **Computed value-add (`/v1/convert`)** — the honest reason to charge for a
   free API: the buyer pays for a calculation (rate lookup + arithmetic), not
   just a proxied endpoint.
3. **Read-through cache** with TTL + `Age`/`Cache-Control`: `latest` is cached
   briefly (FX rates refresh ~daily), historical queries are immutable and
   cached long. Cuts upstream load. Payment still happens per request — caching
   only saves the upstream call.
4. **Per-client rate limiting + structured JSON logs**, applied *after* the
   payment gate, so only paid calls consume the limit.

## Architecture

```
            buyer
              │  GET /v1/latest | /v1/{date} | /v1/{start}..{end} | /v1/convert
              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  frankfurter-x402 (Express, this repo)                         │
   │                                                                │
   │   /healthz ──────────────► 200 (free discovery)                │
   │                                                                │
   │   paymentMiddleware ─────► 402 + PAYMENT-REQUIRED (exact,       │
   │   (x402 gate)                 pieUSD, eip155:2368)             │
   │        │ verified                                              │
   │        ▼                                                       │
   │   rateLimit (per-IP) ──► 429 when over RATE_LIMIT_PER_MIN       │
   │        │                                                       │
   │        ├── /v1/convert ─► computeConversion()  (local math)     │
   │        │                                                        │
   │        └── /v1/* ───────► proxyRequest()                         │
   │                                  │                              │
   │                          ┌───────┴────────┐                     │
   │                          │  in-memory     │  miss               │
   │                          │  cache (TTL)   │────────► fetch       │
   │                          └───────┬────────┘                     │
   │                                  │ hit                          │
   │                                  ▼                              │
   │                          Frankfurter API                        │
   │                          api.frankfurter.dev                    │
   └──────────────────────────────────────────────────────────────┘
              │ settle (EIP-3009 transferWithAuthorization)
              ▼
        Kite facilitator (facilitator.pieverse.io/v2)
              │
              ▼
        Kite chain · pieUSD (eip155:2368)
```

## Tiered pricing

| Endpoint | Tier | Price | Notes |
|---|---|---|---|
| `GET /v1/latest` | standard | $0.001 | latest snapshot |
| `GET /v1/{YYYY-MM-DD}` | standard | $0.001 | single historical day |
| `GET /v1/{START}..{END}` | premium | $0.01 | time series — large payload |
| `GET /v1/convert` | premium | $0.01 | server-computed conversion |

Prices are env-driven: `PRICE_USD` (standard), `PRICE_USD_RANGE` (series),
`CONVERT_PRICE_USD` (convert).

## Run locally

```bash
npm install
cp .env.example .env     # set PAY_TO to your Kite wallet
npm start                # tsx src/index.ts, listens on $PORT (default 8080)
```

Any host that runs Node 22 works (Render, Fly, Cloud Run, a VPS). The service
must be reachable over public https: Kite Passport fetches the URL server-side,
so `localhost` and tunnels that require a browser check will not work.

## Try it

```bash
curl -i "$BASE_URL/healthz"
# 200 { ok:true, network:"eip155:2368", asset:"pieUSD", tiers:{...}, rateLimitPerMin:10, cache:{...} }

curl -i "$BASE_URL/v1/latest?base=USD&symbols=CNY,EUR,JPY"
# 402 with a PAYMENT-REQUIRED header until a payment is attached

curl -i "$BASE_URL/v1/convert?from=USD&to=CNY&amount=100"
# 402 until paid, then 200 { from, to, amount, rate, converted, date }
```

### Self-pay buyer script (verify payment yourself)

`kpass session execute` currently refuses this host client-side — Kite's
executable-service catalog does not yet include `frankfurter-x402.onrender.com`
— so use the buyer script, which signs the EIP-3009 payment directly:

```bash
# any Kite testnet key holding pieUSD
BUYER_PRIVATE_KEY=0x... npm run selfpay

# or a Kite Passport sandbox session
KITE_SESSION_FILE=/path/to/sessions.json npm run selfpay

# pick an endpoint
FX_ENDPOINT=convert FX_FROM=USD FX_TO=CNY FX_AMOUNT=100 npm run selfpay
```

Settlement tx hashes are appended to `proof/paid-calls.jsonl`.

## Cache

`latest` is cached for 1h; historical/series queries are immutable and cached
for 30d (capped at 200 entries, LRU-ish eviction). Cache hits replay the stored
response with an `Age` header and a `public, max-age=…` `Cache-Control`. Only
successful GETs are cached.

## Rate limiting & logs

`RATE_LIMIT_PER_MIN` (default 10, `0` disables) caps paid requests per client IP.
Logs are one-line JSON: `listening`, `proxy_ok`, `cache_hit`, `upstream_unreachable`,
`rate_limited`, `convert_upstream_unreachable`.

## Tests

```bash
npm test
```

Covers: `/healthz` shape, the 402 gate, tiered-amount assertions (series >
latest, day == latest), rate-limiter unit tests, `computeConversion` math, and
`fetchUpstream` forwarding. The facilitator is mocked locally (no network).

## Status

`testnet`. The service answers the x402 challenge on `eip155:2368` in pieUSD.
A paid call has settled on-chain — see `PROOF.md`. Unpaid → `402`, paid → `200`
with the Frankfurter payload (or the computed conversion for `/v1/convert`).

## Related contribution

Proposed to the KiteAI community catalog as
[`gokite-ai/kite-x402-services#4`](https://github.com/gokite-ai/kite-x402-services/pull/4).
