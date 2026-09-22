/**
 * Kite x402 service template (TypeScript + Express).
 *
 * Wraps an existing HTTP API behind x402 payments settled on the Kite chain.
 * Requests to /v1/* return HTTP 402 until the caller attaches a valid
 * PAYMENT-SIGNATURE; the payment is verified by the facilitator, the request
 * is proxied to UPSTREAM_URL, and the payment is settled only if the upstream
 * answered with a non-error status.
 */
import express, { type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FACILITATOR_URL, kiteChainByName, kiteMoneyParser } from "./kite.js";

const env = (key: string, fallback = ""): string => (process.env[key] ?? "").trim() || fallback;

const payTo = env("PAY_TO");
if (!payTo) throw new Error("PAY_TO is required: the Kite wallet address that receives payments");
const chain = kiteChainByName(env("KITE_NETWORK", "mainnet"));
const upstream = new URL(env("UPSTREAM_URL") || "invalid://");
if (!/^https?:$/.test(upstream.protocol)) throw new Error("UPSTREAM_URL is required, e.g. https://api.example.com");
const priceRaw = env("PRICE_USD", "0.001");
const price = priceRaw.startsWith("$") ? priceRaw : `$${priceRaw}`;
const upstreamAuthHeader = env("UPSTREAM_AUTH_HEADER", "Authorization");
const upstreamAuthValue = env("UPSTREAM_AUTH_VALUE");

// 1. Facilitator + Kite pricing.
const facilitator = new HTTPFacilitatorClient({ url: env("FACILITATOR_URL", FACILITATOR_URL) });
const resourceServer = new x402ResourceServer(facilitator).register(
  chain.network,
  new ExactEvmScheme().registerMoneyParser(kiteMoneyParser(chain)),
);

const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, network: chain.network, asset: chain.assetSymbol, price });
});

// 2. Which routes cost money, and how much. Everything under /v1/ is paid.
app.use(
  paymentMiddleware(
    {
      "/v1/*": {
        accepts: {
          scheme: "exact",
          price,
          network: chain.network,
          payTo,
          maxTimeoutSeconds: 60,
        },
        description: env("SERVICE_DESCRIPTION", "Paid API wrapped for the Kite network"),
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

// 3. Proxy paid requests to the API you are wrapping. The upstream credential
//    is injected here and never reaches the caller.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length"]);

app.all("/v1/*path", async (req: Request, res: Response) => {
  // Frankfurter's upstream endpoints already include the /v1 prefix
  // (e.g. /v1/latest), so forward the request path as-is instead of stripping
  // /v1 like the stock template does.
  const target = new URL(req.originalUrl, upstream);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k === "payment-signature") continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  if (upstreamAuthValue) headers.set(upstreamAuthHeader, upstreamAuthValue);

  const hasBody = !["GET", "HEAD"].includes(req.method);
  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? (req as unknown as ReadableStream<Uint8Array>) : undefined,
      duplex: "half",
    } as RequestInit);
  } catch (err) {
    // 502 is >= 400, so the payment middleware does not settle the charge.
    res.status(502).json({ error: "upstream unreachable", detail: String(err) });
    return;
  }

  res.status(upstreamRes.status);
  upstreamRes.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key) && key !== "content-encoding") res.setHeader(key, value);
  });
  res.send(Buffer.from(await upstreamRes.arrayBuffer()));
});

const port = Number(env("PORT", "8080"));
app.listen(port, () => {
  console.log(`kite x402 service on :${port} -> ${upstream} (network ${chain.network}, ${price} per call to ${payTo})`);
});
