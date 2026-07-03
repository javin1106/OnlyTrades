import assert from "node:assert/strict";
import type { Request, RequestHandler, Response } from "express";
import {
  createSlidingWindowRateLimiter,
  createTokenBucketRateLimiter,
  resetRateLimitState,
} from "./rateLimit.middlewares.js";

interface MockResponse {
  statusCode: number | null;
  body: unknown;
  headers: Record<string, string>;
  setHeader: (key: string, value: string) => void;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
}

function createMockRequest(ip: string): Request {
  return {
    ip,
    socket: {
      remoteAddress: ip,
    },
  } as Request;
}

function createMockResponse(): MockResponse {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function runMiddleware(
  middleware: RequestHandler,
  ip = "127.0.0.1",
): { nextCalled: boolean; response: MockResponse } {
  const request = createMockRequest(ip);
  const response = createMockResponse();
  let nextCalled = false;

  middleware(request, response as unknown as Response, () => {
    nextCalled = true;
  });

  return { nextCalled, response };
}

function test(name: string, run: () => void): void {
  try {
    resetRateLimitState();
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test("sliding window blocks requests above the configured limit", () => {
  const limiter = createSlidingWindowRateLimiter({
    keyPrefix: "test-auth",
    maxRequests: 2,
    windowMs: 60_000,
  });

  assert.equal(runMiddleware(limiter).nextCalled, true);
  assert.equal(runMiddleware(limiter).nextCalled, true);

  const blocked = runMiddleware(limiter);
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.response.statusCode, 429);
  assert.equal(blocked.response.headers["Retry-After"], "60");
});

test("sliding window keeps separate buckets per client IP", () => {
  const limiter = createSlidingWindowRateLimiter({
    keyPrefix: "test-auth",
    maxRequests: 1,
    windowMs: 60_000,
  });

  assert.equal(runMiddleware(limiter, "10.0.0.1").nextCalled, true);
  assert.equal(runMiddleware(limiter, "10.0.0.1").response.statusCode, 429);
  assert.equal(runMiddleware(limiter, "10.0.0.2").nextCalled, true);
});

test("token bucket allows bursts up to capacity then blocks", () => {
  const limiter = createTokenBucketRateLimiter({
    keyPrefix: "test-orders",
    capacity: 2,
    refillTokens: 1,
    refillIntervalMs: 10_000,
  });

  assert.equal(runMiddleware(limiter).nextCalled, true);
  assert.equal(runMiddleware(limiter).nextCalled, true);

  const blocked = runMiddleware(limiter);
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.response.statusCode, 429);
  assert.equal(blocked.response.headers["Retry-After"], "10");
});

test("token bucket refills over time", () => {
  const originalDateNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  try {
    const limiter = createTokenBucketRateLimiter({
      keyPrefix: "test-orders",
      capacity: 2,
      refillTokens: 1,
      refillIntervalMs: 10_000,
    });

    assert.equal(runMiddleware(limiter).nextCalled, true);
    assert.equal(runMiddleware(limiter).nextCalled, true);
    assert.equal(runMiddleware(limiter).response.statusCode, 429);

    now += 10_000;
    assert.equal(runMiddleware(limiter).nextCalled, true);
  } finally {
    Date.now = originalDateNow;
  }
});

console.log("RATE_LIMIT_TESTS_OK");
