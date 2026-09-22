# Frankfurter Exchange Rates

Wraps the free, open-source [Frankfurter](https://frankfurter.dev) exchange-rate
API as an x402 service on the Kite chain. Built from the
[typescript-express template](../../templates/typescript-express). The only
changes from the stock template are the `.env` values and the proxy path
forward: Frankfurter's upstream endpoints already include the `/v1` prefix
(e.g. `/v1/latest`), so the wrapper forwards the request path as-is instead of
stripping `/v1`.

| | |
|---|---|
| Endpoint | `GET /v1/latest` → `https://api.frankfurter.dev/v1/latest` |
| Price | $0.001 per call in pieUSD (Kite testnet) |
| Upstream auth | none |

## Deploy

```bash
npm install
cp .env.example .env     # set PAY_TO to your Kite wallet
npm run build && node dist/index.js
```

Any host that runs Node 22 works (Fly, Render, Cloud Run, a VPS). The service
must be reachable over public https: Kite Passport fetches the URL server-side,
so `localhost` and tunnels that require a browser check will not work.

## Try it

```bash
curl -i "$BASE_URL/v1/latest?base=USD&symbols=CNY,EUR,JPY"
# 402 with a PAYMENT-REQUIRED header until a payment is attached

kpass agent session execute --method GET \
  --url "$BASE_URL/v1/latest?base=USD&symbols=CNY,EUR,JPY"
# 200 + Frankfurter JSON, paid from the agent's session
```
