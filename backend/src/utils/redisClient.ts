import { createClient } from "redis";
import {
  cancelEngineResponseWait,
  resolveEngineResponse,
  waitForEngineResponse,
} from "../store/pendingResponses.store.js";
import type {
  EngineCommandType,
  EngineRequest,
  EngineResponse,
} from "../types/engine.types.js";
import { EngineTransportError } from "../types/errors.types.js";
import { withBoundedRetry } from "./retry.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const commandStream =
  process.env.INCOMING_STREAM ?? "backend-to-engine-stream";
const backendQueueId = process.env.BACKEND_QUEUE_ID ?? crypto.randomUUID();
const responseQueue = `response-queue-${backendQueueId}`;
const engineTimeoutMs = Number(process.env.ENGINE_TIMEOUT_MS ?? "30000");
const orderMaxAttempts = readPositiveInteger(
  process.env.ORDER_ENGINE_MAX_ATTEMPTS,
  2,
);
const orderRetryBaseDelayMs = readNonNegativeNumber(
  process.env.ORDER_ENGINE_RETRY_BASE_DELAY_MS,
  250,
);

const commandClient = createClient({ url: redisUrl }); // appends commands to the Redis Stream
const responseClient = createClient({ url: redisUrl }); // blocks on the short-lived response List

commandClient.on("error", (error) => {
  console.error("Redis command Stream producer error:", error);
});

responseClient.on("error", (error) => {
  console.error("Redis response List consumer error:", error);
});

export async function connectRedis(): Promise<void> {
  await Promise.all([commandClient.connect(), responseClient.connect()]);
  console.log("Successfully connected to Redis");
}

export async function sendToEngine(
  type: EngineCommandType,
  payload: Record<string, unknown>,
): Promise<EngineResponse> {
  const correlationId = crypto.randomUUID();
  const responsePromise = waitForEngineResponse(correlationId, engineTimeoutMs);

  const message: EngineRequest = {
    correlationId,
    responseQueue,
    type,
    payload,
  };

  try {
    await commandClient.xAdd(commandStream, "*", {
      request: JSON.stringify(message),
    });
  } catch (error) {
    cancelEngineResponseWait(correlationId);
    throw new EngineTransportError(error);
  }

  return responsePromise;
}

export async function sendCreateOrderToEngine(
  payload: Record<string, unknown>,
): Promise<EngineResponse> {
  if (typeof payload.idempotencyKey !== "string") {
    throw new Error("create_order retries require an idempotency key");
  }

  return withBoundedRetry(
    () => sendToEngine("create_order", payload),
    {
      maxAttempts: orderMaxAttempts,
      baseDelayMs: orderRetryBaseDelayMs,
      onRetry: (error, nextAttempt, delayMs) => {
        console.warn(
          `Retrying create_order (attempt ${nextAttempt}/${orderMaxAttempts}) in ${delayMs}ms:`,
          error,
        );
      },
    },
  );
}

export async function listenForEngineResponses(): Promise<void> {
  console.log(`Listening for engine responses on ${responseQueue}`);

  for (;;) {
    // Infinite loop
    try {
      const response = await responseClient.brPop(responseQueue, 0);
      if (!response) continue;
      const parsed = JSON.parse(response.element) as EngineResponse;
      resolveEngineResponse(parsed);
    } catch (error) {
      console.error("Error processing engine response queue:", error);
    }
  }
}
// Responses remain Lists because they are ephemeral and belong to one backend.

function readPositiveInteger(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeNumber(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
