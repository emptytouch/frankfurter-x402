/**
 * frankfurter-x402 — Frankfurter exchange-rate API behind x402 on the Kite chain.
 *
 * Wraps the free, open-source Frankfurter API (https://frankfurter.dev) as a
 * paid service. Unlike a generic proxy, this service adds three production-grade
 * layers on top of the x402 payment gate:
 *
 *  1. Tiered pricing — `latest` and single historical days are cheap ($0.001);
 *     the time-series (date-range) query and the computed `convert` endpoint are
 *     premium ($0.01), because they return more data / do server-side work.
 *  2. A read-through in-memory cache with TTL + Age/Cache-Control headers, since
 *     FX reference rates update ~daily (ECB): `latest` is cached short, historical
 *     queries are immutable and cached long. This cuts upstream load.
 *  3. Per-client rate limiting + structured JSON logs, applied *after* the
 *     payment gate so only paid calls consume the limit.
 *
 * Discovery endpoints (/healthz) are free so a buyer can inspect the service.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FACILITATOR_URL, kiteChainByName, kiteMoneyParser } from "./kite.js";

const env = (key: string, fallback = ""): string => (process.env[key] ?? "").trim() || fallback;
const money = (v: string): string => (v.startsWith("$") ? v : `$${v}`);

/** Structured one-line JSON logs — easy to grep, ship, or alert on. */
const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
};

const payTo = env("PAY_TO");
if (!payTo) throw new Error("PAY_TO is required: the Kite wallet address that receives payments");
const chain = kiteChainByName(env("KITE_NETWORK", "testnet"));
const upstream = new URL(env("UPSTREAM_URL") || "invalid://");
if (!/^https?:$/.test(upstream.protocol)) throw new Error("UPSTREAM_URL is required, e.g. https://api.frankfurter.dev");

// Tiered pricing. Frankfurter is itself free, so the split reflects *value*:
// a single snapshot is cheap; a multi-day series (much larger payload) and the
// server-computed `convert` are premium.
const stdPrice = money(env("PRICE_USD", "0.001")); // latest + single historical day
const rangePrice = money(env("PRICE_USD_RANGE", "0.01")); // time series (date range)
const convertPrice = money(env("CONVERT_PRICE_USD", "0.01")); // computed conversion endpoint

const upstreamAuthHeader = env("UPSTREAM_AUTH_HEADER", "Authorization");
const upstreamAuthValue = env("UPSTREAM_AUTH_VALUE");

// Rate limiting. Paid calls are the ones that hit the upstream, so cap them per
// client. RATE_LIMIT_PER_MIN=0 disables (useful for load tests). Exported as a
// factory so the behaviour can be unit tested directly.
export function createRateLimiter(perMin: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (!Number.isFinite(perMin) || perMin <= 0) {
      next();
      return;
    }
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    if (bucket.count >= perMin) {
      log("warn", "rate_limited", { key, path: req.path });
      res.status(429).json({ error: "rate limit exceeded", limit_per_min: perMin });
      return;
    }
    bucket.count += 1;
    next();
  };
}

const ratePerMin = Number(env("RATE_LIMIT_PER_MIN", "10"));
const rateLimit = createRateLimiter(ratePerMin);

// 1. Facilitator + Kite pricing.
const facilitator = new HTTPFacilitatorClient({ url: env("FACILITATOR_URL", FACILITATOR_URL) });
const resourceServer = new x402ResourceServer(facilitator).register(
  chain.network,
  new ExactEvmScheme().registerMoneyParser(kiteMoneyParser(chain)),
);

export const app = express();
app.disable("x-powered-by");

// Render terminates TLS in front of the app; advertise the public https origin
// in the 402 body so buyers see the URL they actually called.
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// Read-through cache. Frankfurter data is ECB reference rates that refresh
// ~16:00 CET daily, so `latest` is cached briefly and historical queries
// (immutable) are cached long. Payment still happens per request — caching only
// reduces upstream traffic, never the charge.
// ---------------------------------------------------------------------------
interface CacheEntry {
  at: number;
  ttl: number;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 200;
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length",
]);

function cacheKey(method: string, url: string): string {
  return `${method} ${url}`;
}
/** `latest` changes daily → short TTL; everything historical is immutable → long. */
function ttlForPath(path: string): number {
  return /^\/v1\/latest(\?.*)?$/i.test(path) ? 3_600_000 : 30 * 24 * 3_600_000;
}
function getCache(key: string): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.at + e.ttl) {
    cache.delete(key);
    return null;
  }
  return e;
}
function setCache(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

/** Forward a request to the upstream and return the response. Exported for tests. */
export async function fetchUpstream(target: URL, headers: Headers, method: string, body?: ReadableStream<Uint8Array>): Promise<globalThis.Response> {
  return fetch(target, {
    method,
    headers,
    body: body as unknown as BodyInit | undefined,
    duplex: "half",
  } as RequestInit);
}

/** Serve a cached entry, replaying status/headers and an Age header. */
function serveFromCache(key: string, res: Response): boolean {
  const hit = getCache(key);
  if (!hit) return false;
  const age = Math.floor((Date.now() - hit.at) / 1000);
  res.set("Age", String(age));
  for (const [k, v] of Object.entries(hit.headers)) {
    if (k.toLowerCase() === "cache-control") continue; // we set our own below
    res.set(k, v);
  }
  res.set("Cache-Control", `public, max-age=${Math.max(0, Math.floor((hit.at + hit.ttl - Date.now()) / 1000))}`);
  res.status(hit.status);
  res.send(hit.body);
  log("info", "cache_hit", { key, age, status: hit.status });
  return true;
}

/** Proxy a paid request to the upstream Frankfurter API (latest/day/range). */
export async function proxyRequest(req: Request, res: Response): Promise<void> {
  // Frankfurter's upstream endpoints already include the /v1 prefix, so forward
  // the request path as-is instead of stripping /v1 like the stock template does.
  const target = new URL(req.originalUrl, upstream);
  const key = cacheKey(req.method, target.toString());

  if (serveFromCache(key, res)) return;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k === "payment-signature") continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  if (upstreamAuthValue) headers.set(upstreamAuthHeader, upstreamAuthValue);

  const hasBody = !["GET", "HEAD"].includes(req.method);
  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetchUpstream(target, headers, req.method, hasBody ? (req as unknown as ReadableStream<Uint8Array>) : undefined);
  } catch (err) {
    // 502 is >= 400, so the payment middleware does not settle the charge.
    log("error", "upstream_unreachable", { path: req.path, detail: String(err) });
    res.status(502).json({ error: "upstream unreachable", detail: String(err) });
    return;
  }

  const body = Buffer.from(await upstreamRes.arrayBuffer());

  // Cache successful GETs only (POST/errors are not worth keeping).
  if (req.method === "GET" && upstreamRes.status === 200) {
    const h: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && k !== "content-encoding") h[k] = v;
    });
    setCache(key, { at: Date.now(), ttl: ttlForPath(req.path), status: upstreamRes.status, headers: h, body });
  }

  res.status(upstreamRes.status);
  upstreamRes.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key) && key !== "content-encoding") res.setHeader(key, value);
  });
  res.send(body);
  log("info", "proxy_ok", { path: req.path, status: upstreamRes.status, cached: req.method === "GET" && upstreamRes.status === 200 });
}

// ---------------------------------------------------------------------------
// Computed value-add: currency conversion. A buyer pays for the *calculation*,
// not just a free endpoint — this is the honest reason to charge for a free API.
// ---------------------------------------------------------------------------
export function computeConversion(ratesJson: { rates?: Record<string, number> }, from: string, to: string, amount: number): number {
  const rate = ratesJson?.rates?.[to];
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    throw new Error(`no rate for ${to} (base ${from})`);
  }
  return amount * rate;
}

export async function handleConvert(req: Request, res: Response): Promise<void> {
  const from = String(req.query.from ?? "").trim().toUpperCase();
  const to = String(req.query.to ?? "").trim().toUpperCase();
  const amountRaw = req.query.amount;
  const amount = typeof amountRaw === "string" ? Number(amountRaw) : NaN;

  if (!from || !to || amountRaw === undefined || !Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "from, to (ISO 4217 codes) and a positive numeric amount are required" });
    return;
  }
  if (from === to) {
    res.status(200).json({ from, to, amount, rate: 1, converted: amount, date: null, note: "same currency" });
    return;
  }

  const target = new URL(`/v1/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`, upstream);
  const key = cacheKey("GET", target.toString());

  let ratesJson: { date?: string; rates?: Record<string, number> };
  const hit = getCache(key);
  if (hit && hit.status === 200) {
    ratesJson = JSON.parse(hit.body.toString("utf8"));
  } else {
    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(target);
    } catch (err) {
      log("error", "convert_upstream_unreachable", { from, to, detail: String(err) });
      res.status(502).json({ error: "upstream unreachable", detail: String(err) });
      return;
    }
    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    if (upstreamRes.status !== 200) {
      res.status(502).json({ error: "upstream rate fetch failed", status: upstreamRes.status });
      return;
    }
    ratesJson = JSON.parse(buf.toString("utf8"));
    const h: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && k !== "content-encoding") h[k] = v;
    });
    setCache(key, { at: Date.now(), ttl: ttlForPath("/v1/latest"), status: 200, headers: h, body: buf });
  }

  let converted: number;
  try {
    converted = computeConversion(ratesJson, from, to, amount);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return;
  }
  res.status(200).json({
    from,
    to,
    amount,
    rate: ratesJson.rates?.[to],
    converted: Number(converted.toFixed(6)),
    date: ratesJson.date ?? null,
  });
}

const tiers = {
  latest: { endpoint: "GET /v1/latest", price: stdPrice, description: "latest reference rates" },
  historical: { endpoint: "GET /v1/{YYYY-MM-DD}", price: stdPrice, description: "single historical day" },
  timeseries: { endpoint: "GET /v1/{START}..{END}", price: rangePrice, description: "multi-day series (premium)" },
  convert: { endpoint: "GET /v1/convert", price: convertPrice, description: "server-computed conversion (premium)" },
};

// 2. Free discovery.
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "frankfurter-x402",
    network: chain.network,
    asset: chain.assetSymbol,
    payTo,
    upstream: upstream.origin,
    tiers,
    rateLimitPerMin: ratePerMin,
    cache: { enabled: true, maxEntries: CACHE_MAX },
  });
});

// 3. Payment gate. Order matters: x402 matches with `.find()` and returns the
//    FIRST hit, so more specific patterns MUST precede the `/v1/*` catch-all.
//    `/v1/convert` is a literal path and must come before `/v1/*`, otherwise the
//    catch-all swallows it and charges the standard price.
app.use(
  paymentMiddleware(
    {
      "GET /v1/latest": {
        accepts: { scheme: "exact", price: stdPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Latest Frankfurter reference rates",
        mimeType: "application/json",
      },
      "GET /v1/*..*": {
        accepts: { scheme: "exact", price: rangePrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Frankfurter time series over a date range (premium)",
        mimeType: "application/json",
      },
      "GET /v1/convert": {
        accepts: { scheme: "exact", price: convertPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Server-computed currency conversion (premium)",
        mimeType: "application/json",
      },
      "GET /v1/*": {
        accepts: { scheme: "exact", price: stdPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Frankfurter single historical day",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

// 4. Paid handlers. Rate limiting is applied here (after the gate), so only paid
//    calls consume the limit. Register `convert` before the catch-all so it is
//    not swallowed by the generic proxy.
app.get("/v1/convert", rateLimit, (req: Request, res: Response) => void handleConvert(req, res));
app.all("/v1/*path", rateLimit, (req: Request, res: Response) => void proxyRequest(req, res));

const port = Number(env("PORT", "8080"));
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    log("info", "listening", {
      port,
      upstream: upstream.origin,
      network: chain.network,
      std: stdPrice,
      range: rangePrice,
      convert: convertPrice,
      payTo,
      rateLimitPerMin: ratePerMin,
    });
  });
}
