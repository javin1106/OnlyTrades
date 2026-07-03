import { Router } from "express";
import { signin, signup } from "../controllers/auth.controllers.js";
import { requireAuth } from "../middlewares/auth.middlewares.js";
import { authRateLimiter } from "../middlewares/rateLimit.middlewares.js";

export const authRouter = Router();

authRouter.post("/signup", authRateLimiter, signup);
authRouter.post("/signin", authRateLimiter, signin);
