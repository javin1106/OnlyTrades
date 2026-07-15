import type { ErrorRequestHandler, RequestHandler } from "express";
import { EngineResponseTimeoutError } from "../store/pendingResponses.store.js";
import {
  CorsOriginError,
  EngineTransportError,
} from "../types/errors.types.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.originalUrl,
  });
};

export const jsonErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  next,
): void => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof CorsOriginError) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }

  if (
    error instanceof EngineResponseTimeoutError ||
    error instanceof EngineTransportError
  ) {
    res.setHeader("Retry-After", "1");
    res.status(503).json({
      error: "Exchange engine is temporarily unavailable",
    });
    return;
  }

  if (isRequestBodyError(error, "entity.parse.failed")) {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }

  if (isRequestBodyError(error, "entity.too.large")) {
    res.status(413).json({ error: "Request body is too large" });
    return;
  }

  console.error("Unhandled request error:", error);
  res.status(500).json({ error: "Internal server error" });
};

function isRequestBodyError(
  error: unknown,
  expectedType: string,
): error is { type: string } {
  return (
    !!error &&
    typeof error === "object" &&
    "type" in error &&
    error.type === expectedType
  );
}
