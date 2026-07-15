import "dotenv/config";
import cors from "cors";
import { CorsOriginError } from "../types/errors.types.js";

const defaultFrontendOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const allowedOrigins = new Set(
  (process.env.FRONTEND_ORIGINS ?? defaultFrontendOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

export const corsMiddleware = cors({
  origin(origin, callback) {
    // Requests from Postman, curl, mobile clients, and server-to-server calls
    // do not include a browser Origin header.
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new CorsOriginError(origin));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
  exposedHeaders: ["Idempotency-Key", "Retry-After"],
  maxAge: 86_400,
});
