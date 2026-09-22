# Frankfurter Exchange Rates

Wraps the free, open-source [Frankfurter](https://frankfurter.dev) exchange-rate
API as an x402 service on the Kite chain. Built from the
[typescript-express template](../../templates/typescript-express).

| | |
|---|---|
| Endpoint | `GET /v1/latest` → `https://api.frankfurter.dev/v1/latest` |
| Price | $0.001 per call in pieUSD (Kite testnet) |
| Upstream auth | none |
| Status | `testnet` — https://frankfurter-x402.onrender.com |

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

kpass agent:session execute --method GET \
  --url "$BASE_URL/v1/latest?base=USD&symbols=CNY,EUR,JPY"
# 200 + Frankfurter JSON, settled in pieUSD, tx hash in PAYMENT-RESPONSE
```
