import type { Request, RequestHandler } from "express";

interface SlidingWindowOptions {
  keyPrefix: string;
  maxRequests: number;
  windowMs: number;
}

interface TokenBucketOptions {
  keyPrefix: string;
  capacity: number;
  refillTokens: number;
  refillIntervalMs: number;
}

interface TokenBucketState {
  tokens: number;
  lastRefillAt: number;
}

const slidingWindowHits = new Map<string, number[]>();
const tokenBuckets = new Map<string, TokenBucketState>();

export function resetRateLimitState(): void {
  slidingWindowHits.clear();
  tokenBuckets.clear();
}

function getClientId(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function sendRateLimitResponse(
  res: Parameters<RequestHandler>[1],
  retryAfterSeconds: number,
): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: "Too many requests",
    retryAfterSeconds,
  });
}

export function createSlidingWindowRateLimiter(
  options: SlidingWindowOptions,
): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${options.keyPrefix}:${getClientId(req)}`;
    const windowStart = now - options.windowMs;
    const hits = slidingWindowHits.get(key) ?? [];
    const recentHits = hits.filter((timestamp) => timestamp > windowStart);

    if (recentHits.length >= options.maxRequests) {
      const oldestHit = recentHits[0] ?? now;
      const retryAfterMs = oldestHit + options.windowMs - now;
      sendRateLimitResponse(res, Math.ceil(retryAfterMs / 1000));
      return;
    }

    recentHits.push(now);
    slidingWindowHits.set(key, recentHits);
    next();
  };
}

export function createTokenBucketRateLimiter(
  options: TokenBucketOptions,
): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${options.keyPrefix}:${getClientId(req)}`;
    const bucket =
      tokenBuckets.get(key) ??
      ({
        tokens: options.capacity,
        lastRefillAt: now,
      } satisfies TokenBucketState);

    const elapsedMs = now - bucket.lastRefillAt;
    const intervalsPassed = Math.floor(elapsedMs / options.refillIntervalMs);

    if (intervalsPassed > 0) {
      bucket.tokens = Math.min(
        options.capacity,
        bucket.tokens + intervalsPassed * options.refillTokens,
      );
      bucket.lastRefillAt += intervalsPassed * options.refillIntervalMs;
    }

    if (bucket.tokens < 1) {
      const retryAfterMs = options.refillIntervalMs - (now - bucket.lastRefillAt);
      tokenBuckets.set(key, bucket);
      sendRateLimitResponse(res, Math.ceil(retryAfterMs / 1000));
      return;
    }

    bucket.tokens -= 1;
    tokenBuckets.set(key, bucket);
    next();
  };
}

export const authRateLimiter = createSlidingWindowRateLimiter({
  keyPrefix: "auth",
  maxRequests: 10,
  windowMs: 60_000,
});

export const orderWriteRateLimiter = createTokenBucketRateLimiter({
  keyPrefix: "order-write",
  capacity: 30,
  refillTokens: 5,
  refillIntervalMs: 10_000,
});
