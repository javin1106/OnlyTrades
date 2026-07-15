# OnlyTrades

<p align="center">
  <img width="850" src="https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=1200&q=80" alt="Stock market trading dashboard" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-Engine-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-Backend-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Redis-Streams-DC382D?style=for-the-badge&logo=redis&logoColor=white" alt="Redis Streams" />
  <img src="https://img.shields.io/badge/PostgreSQL-Users-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
</p>

A TypeScript centralized exchange with a separated HTTP API and matching engine. The backend supports authentication, limit and market orders, balance locking, trade settlement, market depth, fills, cancellation, reliable command delivery, and replay-safe order writes.

The project is built to demonstrate exchange-style backend design rather than simple CRUD: the public API handles users and validation, while a separate engine process owns matching and exchange state.

## Features

- Signup/signin with JWT authentication
- PostgreSQL user storage through Prisma
- Redis Streams consumer group for reliable backend-to-engine commands
- Acknowledgement and recovery of interrupted engine commands
- Correlation ID based request/response handling
- Idempotency keys, bounded retries, and self-trade prevention
- Route-specific rate limiting, CORS allowlisting, and JSON error responses
- In-memory matching engine
- Limit and market buy/sell orders
- Price-time priority
- Partial fills and full fills
- Balance locking and settlement
- Order cancellation with locked balance release
- Aggregated order book depth
- Recent fills/trade tape
- Per-user orders and balances

<p align="center">
  <sub>Matching engine after a BUY finally crosses the ASK:</sub><br />
  <img width="330" src="https://media.giphy.com/media/YnkMcHgNIMW4Yfmjxr/giphy.gif" alt="Stonks meme gif" />
</p>

## Tech Stack

| Area | Tech |
| --- | --- |
| Language | TypeScript |
| Runtime | Node.js |
| API | Express |
| Validation | Zod |
| Auth | JWT, bcryptjs |
| Database | PostgreSQL |
| ORM | Prisma |
| Messaging | Redis Streams command log + Redis List responses |
| Engine State | In-memory maps |
| Frontend | React + TypeScript + Vite (next milestone) |

## Architecture

```text
Client / Postman / Planned Frontend
        |
        v
Backend API
  - auth
  - validation
  - Prisma users
  - Redis Stream command producer
        |
        | backend-to-engine-stream
        v
Matching Engine
  - balances
  - orders
  - fills
  - order books
  - matching and settlement
        |
        | response List + correlationId
        v
Backend API Response
```

## Production Architecture Direction

The MVP keeps live exchange state in memory for fast matching. The production direction is to persist engine events for recovery and stream live market data separately from order commands.

```mermaid
flowchart LR
  C[Frontend / Client]
  B[Backend API<br/>Auth + Validation]
  CQ[Redis Command Stream<br/>consumer group + acknowledgements]
  E[Matching Engine<br/>In-memory orderbooks<br/>balances, orders, fills]
  RQ[Redis Response List<br/>response-queue-backend-id]
  DB[(PostgreSQL<br/>users, orders, fills<br/>events, snapshots)]
  PS[Redis Pub/Sub<br/>depth_updates, trade_updates]
  WS[Backend WebSocket Gateway]

  C -- HTTP JSON --> B
  B -- users/auth --> DB
  B -- command + correlationId --> CQ
  CQ --> E
  E -- response + correlationId --> RQ
  RQ --> B
  B -- HTTP response --> C

  E -- order/fill/balance events --> DB
  E -- market data events --> PS
  PS --> WS
  WS -- live depth/trades --> C
```

## Design Choices

### Backend vs Engine

The backend is the public HTTP layer. It owns authentication, request validation, user records, and client responses.

The engine owns exchange logic: order books, balances, fills, matching, settlement, and cancellation. Keeping this logic out of the web server makes the system easier to reason about and closer to real exchange architecture.

### Redis Messaging

Commands use a Redis Stream consumer group. The backend appends commands with `XADD`; the engine reads with `XREADGROUP` and acknowledges with `XACK` only after writing the response. If processing is interrupted, `XAUTOCLAIM` makes the pending command recoverable. Acknowledged entries are removed because this Stream is transport, not the durable exchange ledger.

Responses remain Redis Lists because they are short-lived and belong to one active backend request. Every command carries a `correlationId` and response List name so the backend resolves the correct HTTP request.

### In-Memory Matching

The active order book is kept in memory because matching needs fast access to best bid/ask and FIFO orders at each price level. PostgreSQL currently stores users only; exchange state is held by the engine process.

This means frontend refreshes do not erase data while the server is running, but an engine restart resets exchange state. Durable order/fill/balance persistence is part of the planned production evolution.

### Persistence Boundary

PostgreSQL currently stores only users. A browser refresh does not restart the backend or engine, so server-side balances, books, orders, and fills remain available. The planned frontend will keep the JWT and any in-flight order idempotency key in `sessionStorage`, allowing a refresh to restore the session and safely retry an uncertain request.

An engine restart clears all in-memory balances, order books, orders, fills, and idempotency records. Redis Streams protect command delivery, but they are not a replacement for the durable exchange ledger. See [ARCHITECTURE.md](./ARCHITECTURE.md#persistence-and-failure-behavior) for the full failure matrix.

## Frontend Direction

The next milestone is a desktop-first trading interface built with React, TypeScript, Vite, Tailwind CSS, shadcn/ui, TanStack Query, React Router, Lucide icons, and TradingView Lightweight Charts.

The target layout is an institutional dark terminal with a market selector, price chart, order book, trade ticket, recent fills, open orders, and portfolio balances. Shared primitives will live in `components/ui`; exchange-specific components will wrap them in `components/exchange` so third-party component styles do not leak across the app.

The current API has recent fills rather than persistent OHLC candles. The first chart will display trade-price history or derive short-lived candles from fills; durable candlestick history and live WebSocket updates remain later market-data milestones.

## Matching Engine

<p align="center">
  <img src="https://img.shields.io/badge/Matching-Price--Time%20Priority-22C55E?style=flat-square" alt="Price-time priority" />
  <img src="https://img.shields.io/badge/Orders-Limit%20%2B%20Market-F59E0B?style=flat-square" alt="Limit and market orders" />
  <img src="https://img.shields.io/badge/Settlement-Locked%20Balances-06B6D4?style=flat-square" alt="Balance settlement" />
</p>

Each symbol has an order book:

```ts
{
  bids: Map<number, RestingOrder[]>;
  asks: Map<number, RestingOrder[]>;
}
```

- `bids` store buy orders
- `asks` store sell orders
- price levels are grouped by price
- orders at the same price are matched FIFO

Limit buys consume the lowest asks. Limit sells consume the highest bids. Market buys consume asks using `maxSpend`; market sells consume bids. Market orders never rest on the book.

## API Routes

```http
POST   /signup
POST   /signin
POST   /order
DELETE /order/:orderId
GET    /orders
GET    /order/:orderId
GET    /depth/:symbol
GET    /fills/:symbol
GET    /stocks
GET    /balance
```

Protected routes require:

```http
Authorization: Bearer <jwt>
```

## Example Orders

Limit order:

```json
{
  "type": "limit",
  "side": "buy",
  "symbol": "BTC",
  "price": 100,
  "qty": 2
}
```

Market buy:

```json
{
  "type": "market",
  "side": "buy",
  "symbol": "BTC",
  "qty": 2,
  "maxSpend": 250
}
```

Market sell:

```json
{
  "type": "market",
  "side": "sell",
  "symbol": "BTC",
  "qty": 2
}
```

## Running Locally

Install dependencies:

```bash
cd backend && npm install
cd ../engine && npm install
```

Start Redis:

```bash
docker run --name cex-redis -p 6379:6379 -d redis:7
```

Use your local PostgreSQL instance for the backend database.

Start the engine:

```bash
cd engine
npm run dev
```

Start the backend:

```bash
cd backend
npm run dev
```

Backend runs on:

```text
http://localhost:3000
```

## Environment Variables

Backend:

```env
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/DATABASE
JWT_SECRET=your-secret
REDIS_URL=redis://localhost:6379
PORT=3000
FRONTEND_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Engine:

```env
REDIS_URL=redis://localhost:6379
INCOMING_STREAM=backend-to-engine-stream
ENGINE_CONSUMER_GROUP=matching-engine-group
ENGINE_PENDING_CLAIM_IDLE_MS=30000
```

## Current Scope

The current version focuses on the core exchange workflow:

- authenticated API requests
- backend-to-engine messaging
- in-memory order matching
- balance locking and settlement
- fills, depth, orders, balances, and cancellation
- CORS, structured JSON errors, security headers, and rate limiting
- idempotent order retries and Redis Stream command recovery

Exchange state is memory-first for matching speed. PostgreSQL persistence currently covers users; durable exchange persistence is planned as the next major step.

## Future Scope

- Persist orders, fills, and balance ledger entries
- Add event replay for engine recovery after restart
- Add balance snapshots for faster recovery
- Build the planned React/TypeScript trading interface
- Add persistent OHLCV candle history
- Add Socket.io live depth and trade updates
- Add decimal-safe money representation
- Add stronger domain error types and HTTP mappings
- Add Docker Compose for local infrastructure
- Explore C++/Rust matching-core optimization for the hot path
