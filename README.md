# Frankfurter Exchange Rates

Wraps the free, open-source [Frankfurter](https://frankfurter.dev) exchange-rate
API as an x402 service on the Kite chain. Built from the official
`typescript-express` x402 template.

| | |
|---|---|
| `GET /v1/latest` | latest rates → `https://api.frankfurter.dev/v1/latest` |
| `GET /v1/{YYYY-MM-DD}` | one historical day, e.g. `/v1/2024-01-02` |
| `GET /v1/{START}..{END}` | time series over a date range, e.g. `/v1/2024-01-01..2024-01-31` |
| Price | $0.001 per call in pieUSD (Kite testnet, `eip155:2368`) |
| Upstream auth | none |
| Deployed | `status: testnet` — https://frankfurter-x402.onrender.com |
| Paid proof | tx `0xab67ffbb91c57fc4825553a62b41122ba5c463e703c11d7441f1aaff1409a6aa` |

## Why this is not a `.env`-only wrapper

Frankfurter requires its `/v1` prefix:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' https://api.frankfurter.dev/latest?base=USD
404
$ curl -s -o /dev/null -w '%{http_code}\n' https://api.frankfurter.dev/v1/latest?base=USD
200
```

The stock template strips `/v1` from the inbound path (`CONTRIBUTING.md` step 3
of *Adding a service* describes the contract as "proxied to `UPSTREAM_URL` with
the `/v1` prefix stripped"), which would forward every paid request to
`/latest` and get a 404 back. Following the "edit the proxy code only when the
upstream needs request rewriting" exception, this wrapper forwards the request
path unchanged:

```ts
const target = new URL(req.originalUrl, upstream);
```

`src/kite.ts` is untouched. Two smaller differences from the stock template:
`app.set("trust proxy", 1)`, so the 402 `resource.url` advertises the public
https origin rather than `http://` behind a TLS-terminating host, and
`UPSTREAM_URL` holds the origin only (no path).

Because the forwarded path is untouched, all three Frankfurter routes come
through the same `/v1/*path` handler and share the single `PRICE_USD`.
Frankfurter's own path grammar does the rest of the work — no per-endpoint
routing in the wrapper.

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
# 200 {"ok":true,"network":"eip155:2368","asset":"pieUSD","price":"$0.001"}

curl -i "$BASE_URL/v1/latest?base=USD&symbols=CNY,EUR,JPY"
# 402 with a PAYMENT-REQUIRED header until a payment is attached

kpass session execute --method GET \
  --url "$BASE_URL/v1/latest?base=USD&symbols=CNY,EUR,JPY"
# 200 + Frankfurter JSON, settled in pieUSD, tx hash in PAYMENT-RESPONSE
```

Each declared endpoint is verified against the upstream it forwards to:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY,EUR,JPY"
200
$ curl -s -o /dev/null -w '%{http_code}\n' "https://api.frankfurter.dev/v1/2024-01-02?base=USD&symbols=EUR"
200
$ curl -s -o /dev/null -w '%{http_code}\n' "https://api.frankfurter.dev/v1/2024-01-01..2024-01-31?base=USD&symbols=EUR"
200
```

## Status

`testnet`. The service answers the x402 challenge on `eip155:2368` in pieUSD,
and a paid call has settled on-chain:

```json
{
  "network": "eip155:2368",
  "payer": "0x92DF53ED56E3baCc6b9F2b1E10ACdA5355Fbf9C9",
  "payTo": "0x9e610Cd701472bF7C815a6404B6Ff88D81838C91",
  "amount": "1000000000000000",
  "transaction": "0xab67ffbb91c57fc4825553a62b41122ba5c463e703c11d7441f1aaff1409a6aa"
}
```

Unpaid → `402`, paid → `200` with the Frankfurter payload. Note: `kpass session
execute` currently refuses this host client-side — Kite's executable-service
catalog does not yet include `frankfurter-x402.onrender.com` — so the paid call
above was signed with a Kite Passport sandbox session key via the `@x402` client
SDK against the Kite facilitator (`https://facilitator.pieverse.io/v2`). Asking
Kite to admit the host to the catalog enables the CLI path for regular buyers.

## Related contribution

The same wrapper is proposed to the KiteAI community catalog as
[`gokite-ai/kite-x402-services#4`](https://github.com/gokite-ai/kite-x402-services/pull/4).
