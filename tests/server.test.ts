import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, createRateLimiter, computeConversion, fetchUpstream } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /healthz", () => {
  it("returns 200 with network + tier + cache info", async () => {
    const r = await request(app).get("/healthz");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.network).toBe("eip155:2368");
    expect(r.body.asset).toBe("pieUSD");
    expect(r.body.tiers.latest.price).toBe("$0.001");
    expect(r.body.tiers.timeseries.price).toBe("$0.01");
    expect(r.body.tiers.convert.price).toBe("$0.01");
    expect(r.body.cache.enabled).toBe(true);
  });
});

describe("GET /v1/latest unpaid", () => {
  it("returns 402 with a PAYMENT-REQUIRED header", async () => {
    const r = await request(app).get("/v1/latest?base=USD&symbols=CNY");
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });
});

describe("tiered pricing", () => {
  const decodeAmount = (header: unknown): string => {
    const decoded = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
    return String(decoded.accepts[0].amount);
  };

  it("gates the premium time-series behind its own 402", async () => {
    const r = await request(app).get("/v1/2024-01-01..2024-01-31?base=USD&symbols=EUR");
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });

  it("gates the computed convert endpoint behind its own 402", async () => {
    const r = await request(app).get("/v1/convert?from=USD&to=CNY&amount=100");
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });

  it("charges more on the time-series tier than the latest tier", async () => {
    const latest = await request(app).get("/v1/latest?base=USD&symbols=CNY");
    const series = await request(app).get("/v1/2024-01-01..2024-01-31?base=USD&symbols=EUR");
    const latestAmount = decodeAmount(latest.headers["payment-required"]);
    const seriesAmount = decodeAmount(series.headers["payment-required"]);
    expect(BigInt(seriesAmount)).toBeGreaterThan(BigInt(latestAmount));
  });

  it("charges the same standard price for latest and a single historical day", async () => {
    const latest = await request(app).get("/v1/latest?base=USD&symbols=CNY");
    const day = await request(app).get("/v1/2024-01-02?base=USD&symbols=EUR");
    const latestAmount = decodeAmount(latest.headers["payment-required"]);
    const dayAmount = decodeAmount(day.headers["payment-required"]);
    expect(dayAmount).toBe(latestAmount);
  });
});

describe("rate limiter", () => {
  const mkRes = () => {
    const res: any = { statusCode: 0, body: null };
    res.status = (c: number) => {
      res.statusCode = c;
      return res;
    };
    res.json = (b: unknown) => {
      res.body = b;
      return res;
    };
    return res;
  };
  const mkReq = (ip: string) => ({ ip, path: "/v1/latest" }) as any;

  it("allows up to the limit, then returns 429", () => {
    const limiter = createRateLimiter(2);
    let passed = 0;
    const next = () => {
      passed += 1;
    };

    limiter(mkReq("1.2.3.4"), mkRes(), next);
    limiter(mkReq("1.2.3.4"), mkRes(), next);
    const third = mkRes();
    limiter(mkReq("1.2.3.4"), third, next);

    expect(passed).toBe(2);
    expect(third.statusCode).toBe(429);
  });

  it("counts each client separately", () => {
    const limiter = createRateLimiter(1);
    const next = () => {};
    limiter(mkReq("1.1.1.1"), mkRes(), next);
    const other = mkRes();
    limiter(mkReq("2.2.2.2"), other, next);
    expect(other.statusCode).toBe(0); // different client is not limited
  });

  it("is a no-op when disabled", () => {
    const limiter = createRateLimiter(0);
    let passed = 0;
    const next = () => {
      passed += 1;
    };
    for (let i = 0; i < 5; i++) limiter(mkReq("1.2.3.4"), mkRes(), next);
    expect(passed).toBe(5);
  });
});

describe("computeConversion", () => {
  it("multiplies amount by the rate", () => {
    expect(computeConversion({ rates: { CNY: 7.12 } }, "USD", "CNY", 100)).toBeCloseTo(712);
  });

  it("throws when the target rate is missing", () => {
    expect(() => computeConversion({ rates: { EUR: 0.9 } }, "USD", "CNY", 100)).toThrow(/no rate for CNY/);
  });
});

describe("fetchUpstream", () => {
  it("forwards method + headers + body to the target URL", async () => {
    const seen: any = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init: any) => {
        seen.url = String(input);
        seen.method = init.method;
        seen.headers = Object.fromEntries((init.headers as Headers).entries());
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const headers = new Headers({ "x-test": "1" });
    const res = await fetchUpstream(new URL("https://api.frankfurter.dev/v1/latest?base=USD"), headers, "GET");
    expect(res.status).toBe(200);
    expect(seen.url).toBe("https://api.frankfurter.dev/v1/latest?base=USD");
    expect(seen.method).toBe("GET");
    expect(seen.headers["x-test"]).toBe("1");
  });
});
