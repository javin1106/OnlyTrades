import "dotenv/config";
import { createClient } from "redis";
import { getUserBalance } from "./services/exchange.service.js";

type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

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
    case "create_order":
      return {
        orderId: crypto.randomUUID(),
        status: "open",
        filledQty: 0,
        fills: [],
        receivedPayload: message.payload,
        note: "Dummy engine response. Matching logic comes next.",
      };

    case "get_depth":
      throw new Error("Get depth not implemented yet");
    case "get_user_balance": {
      const userId = message.payload.userId;

      if (typeof userId !== "string") {
        throw new Error("userId is required");
      }

      return getUserBalance(userId);
    }
    case "get_order":
      throw new Error("Get order not implemented yet");
    case "cancel_order":
      throw new Error("Cancel order not implemented yet");
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
