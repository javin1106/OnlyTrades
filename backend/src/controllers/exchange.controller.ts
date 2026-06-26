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

  const engineResponse = await sendToEngine("create_order", {
    userId,
    ...result.data,
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

  res.status(501).json({ error: "Cancellation not implemented" });
}

export async function getOrders(req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: "Order listing not implemented" });
}

export async function getOrderBook(req: Request, res: Response): Promise<void> {
  const result = symbolParamSchema.safeParse(req.params);

  if (!result.success) {
    res.status(400).json({ error: "Invalid symbol" });
    return;
  }

  res.status(501).json({ error: "Order book not implemented" });
}

export async function getFills(req: Request, res: Response): Promise<void> {
  const result = symbolParamSchema.safeParse(req.params);

  if (!result.success) {
    res.status(400).json({ error: "Invalid symbol" });
    return;
  }

  res.status(501).json({ error: "Fills not implemented" });
}

export async function getStocks(req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: "Stocks not implemented" });
}

export async function getBalance(req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: "Balance not implemented" });
}
