import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { EngineResponseTimeoutError } from "../store/pendingResponses.store.js";
import { corsMiddleware } from "./cors.middlewares.js";
import {
  jsonErrorHandler,
  notFoundHandler,
} from "./error.middlewares.js";

const app = express();
app.use(corsMiddleware);
app.use(express.json({ limit: "100kb" }));
app.get("/ok", (_req, res) => res.json({ ok: true }));
app.post("/echo", (req, res) => res.json(req.body));
app.get("/engine-timeout", () => {
  throw new EngineResponseTimeoutError();
});
app.use(notFoundHandler);
app.use(jsonErrorHandler);

const server = app.listen(0);

try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const allowedResponse = await fetch(`${baseUrl}/ok`, {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(allowedResponse.status, 200);
  assert.equal(
    allowedResponse.headers.get("access-control-allow-origin"),
    "http://localhost:5173",
  );
  assert.match(
    allowedResponse.headers.get("access-control-expose-headers") ?? "",
    /Idempotency-Key/,
  );

  const preflightResponse = await fetch(`${baseUrl}/echo`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "authorization,content-type,idempotency-key",
    },
  });
  assert.equal(preflightResponse.status, 204);
  assert.equal(
    preflightResponse.headers.get("access-control-allow-origin"),
    "http://localhost:5173",
  );
  assert.match(
    preflightResponse.headers.get("access-control-allow-headers") ?? "",
    /Idempotency-Key/i,
  );

  const nonBrowserResponse = await fetch(`${baseUrl}/ok`);
  assert.equal(nonBrowserResponse.status, 200);

  const blockedResponse = await fetch(`${baseUrl}/ok`, {
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(blockedResponse.status, 403);
  assert.deepEqual(await blockedResponse.json(), {
    error: "Origin not allowed",
  });

  const timeoutResponse = await fetch(`${baseUrl}/engine-timeout`);
  assert.equal(timeoutResponse.status, 503);
  assert.equal(timeoutResponse.headers.get("retry-after"), "1");
  assert.deepEqual(await timeoutResponse.json(), {
    error: "Exchange engine is temporarily unavailable",
  });

  const malformedJsonResponse = await fetch(`${baseUrl}/echo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformedJsonResponse.status, 400);
  assert.deepEqual(await malformedJsonResponse.json(), {
    error: "Malformed JSON body",
  });

  const missingRouteResponse = await fetch(`${baseUrl}/missing`);
  assert.equal(missingRouteResponse.status, 404);
  assert.deepEqual(await missingRouteResponse.json(), {
    error: "Route not found",
    path: "/missing",
  });

  console.log("HTTP_MIDDLEWARE_TESTS_OK");
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
