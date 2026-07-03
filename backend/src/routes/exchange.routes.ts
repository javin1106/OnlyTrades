import { Router } from "express";
import {
  cancelOrder,
  createOrder,
  getBalance,
  getDepth,
  getFills,
  getOrders,
  getOrder,
  getStocks,
} from "../controllers/exchange.controller.js";
import { requireAuth } from "../middlewares/auth.middlewares.js";
import { orderWriteRateLimiter } from "../middlewares/rateLimit.middlewares.js";

export const exchangeRouter = Router();

exchangeRouter.post("/order", requireAuth, orderWriteRateLimiter, createOrder);
exchangeRouter.delete(
  "/order/:orderId",
  requireAuth,
  orderWriteRateLimiter,
  cancelOrder,
);
exchangeRouter.get("/orders", requireAuth, getOrders);
exchangeRouter.get("/order/:orderId", requireAuth, getOrder);
exchangeRouter.get("/depth/:symbol", requireAuth, getDepth);
exchangeRouter.get("/fills/:symbol", requireAuth, getFills);
exchangeRouter.get("/stocks", requireAuth, getStocks);
exchangeRouter.get("/balance", requireAuth, getBalance);
