# Centralised Exchange

<p align="center">
  <img width="850" src="https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=1200&q=80" alt="Stock market trading dashboard" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-Engine-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-Backend-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Redis-Queue-DC382D?style=for-the-badge&logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/PostgreSQL-Users-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
</p>

A TypeScript backend for a centralized exchange with a separated HTTP API and matching engine. The system supports authentication, limit orders, market orders, balance locking, trade settlement, market depth, fills, and cancellation.

The project is built to demonstrate exchange-style backend design rather than simple CRUD: the public API handles users and validation, while a separate engine process owns matching and exchange state.

## Features

- Signup/signin with JWT authentication
- PostgreSQL user storage through Prisma
- Redis queue-based backend-to-engine communication
- Correlation ID based request/response handling
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
| Messaging | Redis queues |
| Engine State | In-memory maps |

## Architecture

```text
Client / Postman / Future Frontend
        |
        v
Backend API
  - auth
  - validation
  - Prisma users
  - Redis command producer
        |
        | backend-to-engine-broker
        v
Matching Engine
  - balances
  - orders
  - fills
  - order books
  - matching and settlement
        |
        | response queue + correlationId
        v
Backend API Response
```

## Production Architecture Direction

The MVP keeps live exchange state in memory for fast matching. The production direction is to persist engine events for recovery and stream live market data separately from order commands.

```mermaid
flowchart LR
  C[Frontend / Client]
  B[Backend API<br/>Auth + Validation]
  CQ[Redis Command Queue<br/>backend-to-engine-broker]
  E[Matching Engine<br/>In-memory orderbooks<br/>balances, orders, fills]
  RQ[Redis Response Queue<br/>response-queue-backend-id]
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

### Redis Queues

Redis is used as a message broker between the backend and engine. Each backend request sent to the engine includes a `correlationId` and a response queue, allowing the backend to resolve the correct HTTP request when the engine replies.

### In-Memory Matching

The active order book is kept in memory because matching needs fast access to best bid/ask and FIFO orders at each price level. PostgreSQL currently stores users only; exchange state is held by the engine process.

This means frontend refreshes do not erase data while the server is running, but an engine restart resets exchange state. Durable order/fill/balance persistence is part of the planned production evolution.

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
```

Engine:

```env
REDIS_URL=redis://localhost:6379
INCOMING_QUEUE=backend-to-engine-broker
```

## Current Scope

The current version focuses on the core exchange workflow:

- authenticated API requests
- backend-to-engine messaging
- in-memory order matching
- balance locking and settlement
- fills, depth, orders, balances, and cancellation

Exchange state is memory-first for matching speed. PostgreSQL persistence currently covers users; durable exchange persistence is planned as the next major step.

## Future Scope

- Persist orders, fills, and balance ledger entries
- Add event replay for engine recovery after restart
- Add balance snapshots for faster recovery
- Build a React/TypeScript frontend
- Add Socket.io live depth and trade updates
- Add decimal-safe money representation
- Add stronger domain error types and HTTP mappings
- Add Docker Compose for local infrastructure
- Explore C++/Rust matching-core optimization for the hot path
