import "dotenv/config";
import { createClient } from "redis";
import {
  getDepth,
  getStocks,
  getUserBalance,
  getOrder,
  getUserOrders,
  getFills,
  createOrder,
  cancelOrder,
} from "./services/exchange.service.js";

type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "get_orders"
  | "cancel_order"
  | "get_fills"
  | "get_stocks";

interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const commandStream =
  process.env.INCOMING_STREAM ?? "backend-to-engine-stream";
const consumerGroup =
  process.env.ENGINE_CONSUMER_GROUP ?? "matching-engine-group";
const consumerName =
  process.env.ENGINE_CONSUMER_NAME ??
  `engine-${process.pid}-${crypto.randomUUID()}`;
const deadLetterStream = `${commandStream}:dead-letter`;
const pendingClaimIdleMs = readPositiveNumber(
  process.env.ENGINE_PENDING_CLAIM_IDLE_MS,
  30_000,
);

const brokerClient = createClient({ url: redisUrl });
const responseClient = createClient({ url: redisUrl });

brokerClient.on("error", (error) => {
  console.error("Redis command Stream consumer error:", error);
});

responseClient.on("error", (error) => {
  console.error("Redis response List producer error:", error);
});

async function sendResponse(
  responseQueue: string,
  response: EngineResponse,
): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

function handleEngineRequest(message: EngineRequest): unknown {
  switch (message.type) {
    case "create_order": {
      const { userId, type, side, symbol, price, qty, maxSpend, idempotencyKey } =
        message.payload;
      if (typeof userId !== "string") throw new Error("userId is required");
      if (type !== "limit" && type !== "market") {
        throw new Error("type is invalid");
      }
      if (side !== "buy" && side !== "sell") throw new Error("side is invalid");
      if (typeof symbol !== "string") throw new Error("symbol is required");
      if (typeof qty !== "number") throw new Error("qty is required");

      if (type === "limit" && typeof price !== "number") {
        throw new Error("price is required for limit orders");
      }

      if (type === "market" && side === "buy" && typeof maxSpend !== "number") {
        throw new Error("maxSpend is required for market buy orders");
      }

      if (
        idempotencyKey !== undefined &&
        typeof idempotencyKey !== "string"
      ) {
        throw new Error("idempotencyKey must be a string");
      }

      const orderPrice = type === "limit" ? (price as number) : null;

      return createOrder({
        userId,
        type,
        side,
        symbol,
        price: orderPrice,
        qty,
        ...(typeof maxSpend === "number" ? { maxSpend } : {}),
        ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
      });
    }

    case "get_depth": {
      const symbol = message.payload.symbol;

      if (typeof symbol !== "string") {
        throw new Error("symbol is required");
      }

      return getDepth(symbol);
    }

    case "get_user_balance": {
      const userId = message.payload.userId;

      if (typeof userId !== "string") {
        throw new Error("userId is required");
      }

      return getUserBalance(userId);
    }

    case "get_orders": {
      const userId = message.payload.userId;

      if (typeof userId !== "string") {
        throw new Error("userId is required");
      }

      return getUserOrders(userId);
    }

    case "get_order": {
      const userId = message.payload.userId;
      const orderId = message.payload.orderId;

      if (typeof userId !== "string") {
        throw new Error("userId is required");
      }

      if (typeof orderId !== "string") {
        throw new Error("orderId is required");
      }

      return getOrder(userId, orderId);
    }

    case "get_fills": {
      const symbol = message.payload.symbol;
      if (typeof symbol !== "string") {
        throw new Error("symbol is required");
      }

      return getFills(symbol);
    }

    case "cancel_order": {
      const userId = message.payload.userId;
      const orderId = message.payload.orderId;

      if (typeof userId !== "string") {
        throw new Error("userId is required");
      }

      if (typeof orderId !== "string") {
        throw new Error("orderId is required");
      }

      return cancelOrder(userId, orderId);
    }

    case "get_stocks":
      return getStocks();

    default:
      throw new Error("Unknown engine command");
  }
}

await Promise.all([brokerClient.connect(), responseClient.connect()]);
await ensureConsumerGroup();

console.log(
  `Engine consuming Redis Stream ${commandStream} as ${consumerGroup}/${consumerName}`,
);

for (;;) {
  try {
    const entry = (await claimPendingCommand()) ?? (await readNewCommand());
    if (!entry) continue;

    await processCommandEntry(entry);
  } catch (error) {
    console.error("Error consuming command stream:", error);
    await delay(1_000);
  }
}

interface CommandStreamEntry {
  id: string;
  rawRequest: string;
}

async function ensureConsumerGroup(): Promise<void> {
  try {
    await brokerClient.xGroupCreate(commandStream, consumerGroup, "0", {
      MKSTREAM: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("BUSYGROUP")) {
      return;
    }

    throw error;
  }
}

async function claimPendingCommand(): Promise<CommandStreamEntry | null> {
  const claimed = await brokerClient.xAutoClaim(
    commandStream,
    consumerGroup,
    consumerName,
    pendingClaimIdleMs,
    "0-0",
    { COUNT: 1 },
  );

  const message = claimed.messages[0];
  return message ? toCommandStreamEntry(message) : null;
}

async function readNewCommand(): Promise<CommandStreamEntry | null> {
  const streams = await brokerClient.xReadGroup(
    consumerGroup,
    consumerName,
    { key: commandStream, id: ">" },
    { COUNT: 1, BLOCK: 5_000 },
  );

  const message = streams?.[0]?.messages[0];
  return message ? toCommandStreamEntry(message) : null;
}

function toCommandStreamEntry(message: {
  id: string;
  message: Record<string, string>;
}): CommandStreamEntry {
  return {
    id: message.id,
    rawRequest: message.message.request ?? "",
  };
}

async function processCommandEntry(entry: CommandStreamEntry): Promise<void> {
  let message: EngineRequest;

  try {
    const parsed: unknown = JSON.parse(entry.rawRequest);
    if (!isEngineRequest(parsed)) {
      throw new Error("Invalid engine request envelope");
    }

    message = parsed;
  } catch (error) {
    await brokerClient.xAdd(deadLetterStream, "*", {
      sourceId: entry.id,
      rawRequest: entry.rawRequest,
      error: error instanceof Error ? error.message : "invalid_request",
    });
    await acknowledgeCommand(entry.id);
    console.error(`Moved invalid command ${entry.id} to ${deadLetterStream}`);
    return;
  }

  let response: EngineResponse;

  try {
    response = {
      correlationId: message.correlationId,
      ok: true,
      data: handleEngineRequest(message),
    };
  } catch (error) {
    response = {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    };
  }

  // Acknowledge only after the response is safely written.
  await sendResponse(message.responseQueue, response);
  await acknowledgeCommand(entry.id);
}

async function acknowledgeCommand(messageId: string): Promise<void> {
  await brokerClient.xAck(commandStream, consumerGroup, messageId);

  try {
    await brokerClient.xDel(commandStream, messageId);
  } catch (error) {
    // The command is already acknowledged; failed cleanup must not replay it.
    console.error(`Could not delete acknowledged command ${messageId}:`, error);
  }
}

function isEngineRequest(value: unknown): value is EngineRequest {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<EngineRequest>;
  return (
    typeof candidate.correlationId === "string" &&
    typeof candidate.responseQueue === "string" &&
    typeof candidate.type === "string" &&
    !!candidate.payload &&
    typeof candidate.payload === "object"
  );
}

function readPositiveNumber(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function delay(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
