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
const incomingQueue = process.env.INCOMING_QUEUE ?? "backend-to-engine-broker";

const brokerClient = createClient({ url: redisUrl });
const responseClient = createClient({ url: redisUrl });

brokerClient.on("error", (error) => {
  console.error("Redis broker client error:", error);
});

responseClient.on("error", (error) => {
  console.error("Redis response client error:", error);
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
      const { userId, type, side, symbol, price, qty } = message.payload;
      if (typeof userId !== "string") throw new Error("userId is required");
      if (type !== "limit") {
        throw new Error("Market orders are not implemented yet");
      }
      if (side !== "buy" && side !== "sell") throw new Error("side is invalid");
      if (typeof symbol !== "string") throw new Error("symbol is required");
      if (typeof qty !== "number") throw new Error("qty is required");
      if (typeof price !== "number") {
        throw new Error("price is required for limit orders");
      }

      return createOrder({
        userId,
        type,
        side,
        symbol,
        price,
        qty,
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

    case "cancel_order":
      throw new Error("Cancel order not implemented yet");

    case "get_stocks":
      return getStocks();

    default:
      throw new Error("Unknown engine command");
  }
}

await Promise.all([brokerClient.connect(), responseClient.connect()]);

console.log(`Engine listening on Redis queue: ${incomingQueue}`);

for (;;) {
  const item = await brokerClient.brPop(incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;

  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    const data = handleEngineRequest(message);

    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}
