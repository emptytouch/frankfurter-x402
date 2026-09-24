# Paid-call proof (x402 on Kite testnet `eip155:2368`, pieUSD)

Every paid endpoint below settled on-chain via the Kite facilitator
(`facilitator.pieverse.io/v2`). Hashes are reproducible: run
`npm run selfpay` (see README) against the deployed service with any Kite
testnet key holding pieUSD.

## Verified transactions

| Endpoint | Tier | Price | Tx hash | Buyer |
|---|---|---|---|---|
| `GET /v1/latest` | standard | $0.001 | `0xab67ffbb91c57fc4825553a62b41122ba5c463e703c11d7441f1aaff1409a6aa` | sandbox session |
| `GET /v1/{date}` | standard | $0.001 | _(add after redeploy)_ | |
| `GET /v1/{start}..{end}` | premium | $0.01 | _(add after redeploy)_ | |
| `GET /v1/convert` | premium | $0.01 | _(add after redeploy)_ | |

Pre-deepening settlement (latest, $0.001) — full payload:

```json
{
  "network": "eip155:2368",
  "payer": "0x92DF53ED56E3baCc6b9F2b1E10ACdA5355Fbf9C9",
  "payTo": "0x9e610Cd701472bF7C815a6404B6ff88D81838C91",
  "amount": "1000000000000000",
  "transaction": "0xab67ffbb91c57fc4825553a62b41122ba5c463e703c11d7441f1aaff1409a6aa"
}
```

## How to (re)generate proof after a deploy

```bash
# standard: latest
npm run selfpay

# standard: single historical day
FX_ENDPOINT=historical FX_DATE=2024-01-02 npm run selfpay

# premium: time series
FX_ENDPOINT=timeseries FX_START=2024-01-01 FX_END=2024-01-31 npm run selfpay

# premium: computed conversion
FX_ENDPOINT=convert FX_FROM=USD FX_TO=CNY FX_AMOUNT=100 npm run selfpay
```

Each run appends the settlement tx to `proof/paid-calls.jsonl`. Paste the four
hashes into the table above and on the bounty dashboard.
