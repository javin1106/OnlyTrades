import express from "express";
import "dotenv/config";
import { authRouter } from "./routes/auth.routes.js";
import { exchangeRouter } from "./routes/exchange.routes.js";
import { connectRedis, listenForEngineResponses } from "./utils/redisClient.js";
import { securityHeaders } from "./middlewares/securityHeaders.middlewares.js";
import { corsMiddleware } from "./middlewares/cors.middlewares.js";
import {
  jsonErrorHandler,
  notFoundHandler,
} from "./middlewares/error.middlewares.js";

const PORT = Number(process.env.PORT ?? 3000);

await connectRedis();
void listenForEngineResponses(); // let run in background

const app = express();
app.use(securityHeaders);
app.use(corsMiddleware);
app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
  });
});

app.use(authRouter);
app.use(exchangeRouter);
app.use(notFoundHandler);
app.use(jsonErrorHandler);

app.listen(PORT, () => {
  console.log(`Server running on PORT ${PORT}`);
});
