import express from "express";
import "dotenv/config";
import { authRouter } from "./routes/auth.routes.js";
import { exchangeRouter } from "./routes/exchange.routes.js";
import { connectRedis, listenForEngineResponses } from "./utils/redisClient.js";

const PORT = Number(process.env.PORT ?? 3000);

await connectRedis();
void listenForEngineResponses(); // let run in background

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
  });
});

app.use(authRouter);
app.use(exchangeRouter);

app.listen(PORT, () => {
  console.log(`Server running on PORT ${PORT}`);
});
