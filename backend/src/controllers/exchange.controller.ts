import type { Request, Response } from "express";
import {
  orderBodySchema,
  orderIdParamSchema,
  symbolParamSchema,
} from "../types/exchangeSchema.types.js";
import { sendToEngine } from "../utils/redisClient.js";

export async function createOrder(req: Request, res: Response): Promise<void> {
  const result = orderBodySchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "Invalid order",
      details: result.error.flatten(),
    });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let idempotencyKey: string | null;
  try {
    idempotencyKey = getIdempotencyKey(req);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid idempotency key",
    });
    return;
  }

  const engineResponse = await sendToEngine("create_order", {
    userId,
    ...result.data,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  res
    .status(engineResponse.ok ? 200 : 400)
    .json(
      engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
    );
}

export async function cancelOrder(req: Request, res: Response): Promise<void> {
  const result = orderIdParamSchema.safeParse(req.params);

  if (!result.success) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const engineResponse = await sendToEngine("cancel_order", {
    userId,
    orderId: result.data.orderId,
  });

  const statusCode = engineResponse.ok
    ? 200
    : engineResponse.error === "Order not found"
      ? 404
      : 400;

  res
    .status(statusCode)
    .json(
      engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
    );
}

function getIdempotencyKey(req: Request): string | null {
  const rawKey = req.header("Idempotency-Key");

  if (!rawKey) return null;

  const idempotencyKey = rawKey.trim();

  if (!idempotencyKey) return null;

  if (idempotencyKey.length > 128) {
    throw new Error("Idempotency-Key is too long");
  }

  return idempotencyKey;
}

export async function getOrders(req: Request, res: Response): Promise<void> {
  const userId = req.userId;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const engineResponse = await sendToEngine("get_orders", { userId });

  res
    .status(engineResponse.ok ? 200 : 400)
    .json(
      engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
    );
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const result = orderIdParamSchema.safeParse(req.params);
  if (!result.success) {
    res.status(400).json({ error: "Invalid Order ID" });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const engineResponse = await sendToEngine("get_order", {
    userId,
    orderId: result.data.orderId,
  });

  res
    .status(engineResponse.ok ? 200 : 404)
    .json(
      engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
    );
}

export async function getDepth(req: Request, res: Response): Promise<void> {
  const result = symbolParamSchema.safeParse(req.params);

  if (!result.success) {
    res.status(400).json({ error: "Invalid symbol" });
    return;
  }

  const engineResponse = await sendToEngine("get_depth", {
    symbol: result.data.symbol,
  });

  res
    .status(engineResponse.ok ? 200 : 400)
    .json(
      engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
    );
}

export async function getFills(req: Request, res: Response): Promise<void> {
  const result = symbolParamSchema.safeParse(req.params);

  if (!result.success) {
    res.status(400).json({ error: "Invalid symbol" });
    return;
  }

  const engineResponse = await sendToEngine("get_fills", {
    symbol: result.data.symbol,
  });

  res
    .status(engineResponse.ok ? 200 : 400)
    .json(
      engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
    );
}

export async function getStocks(req: Request, res: Response): Promise<void> {
  const engineResponse = await sendToEngine("get_stocks", {});
  res
    .status(engineResponse.ok ? 200 : 400)
    .json(
      engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
    );
}

export async function getBalance(req: Request, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const engineResponse = await sendToEngine("get_user_balance", { userId });

  res
    .status(engineResponse.ok ? 200 : 400)
    .json(
      engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
    );
}
