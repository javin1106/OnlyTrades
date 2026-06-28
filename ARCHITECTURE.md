# CEX Assignment Architecture

This project follows the boilerplate README architecture:

```text
Client / Postman
  -> Backend API on port 3000
  -> Redis queue: backend-to-engine-broker
  -> Engine worker process
  -> Backend-specific response queue
  -> Backend API response
```

## What Each Part Owns

### Backend

The backend is the public HTTP API.

It owns:

- signup and signin
- PostgreSQL user records through Prisma
- password hashing
- JWT creation and JWT middleware
- request validation with Zod
- sending engine commands to Redis
- waiting for engine responses by `correlationId`
- returning HTTP responses to the client

It does not own:

- order matching
- order books
- balances
- fills
- exchange state

### Engine

The engine is not a public HTTP API in the assignment architecture.

It is a worker process that listens to Redis, owns in-memory state, and replies through Redis.

It owns:

- stocks
- balances
- orders
- fills
- order books
- matching logic
- balance locking and settlement
- cancellation logic

### PostgreSQL

PostgreSQL stores users only in the current assignment version.

It does not store orders, fills, balances, or order books yet.

### Redis

Redis is not the database for the exchange.

Redis is the message transport between backend and engine:

- backend pushes command messages
- engine pops command messages
- engine pushes response messages
- backend pops responses and matches them with `correlationId`

## Exact Create Order Workflow

Example request:

```http
POST /order
Authorization: Bearer alice-token
Content-Type: application/json

{
  "type": "limit",
  "side": "buy",
  "symbol": "BTC",
  "price": 100,
  "qty": 10
}
```

Step by step:

1. Client sends `POST /order` to the backend.
2. Backend JWT middleware verifies `alice-token`.
3. Backend gets `userId` from the verified token.
4. Backend validates the request body with Zod.
5. Backend creates a message:

```ts
{
  correlationId: "random-uuid",
  responseQueue: "response-queue-backend-1",
  type: "create_order",
  payload: {
    userId: "alice-user-id",
    type: "limit",
    side: "buy",
    symbol: "BTC",
    price: 100,
    qty: 10
  }
}
```

6. Backend pushes that message to Redis queue `backend-to-engine-broker`.
7. Backend waits for a response with the same `correlationId`.
8. Engine pops the message from `backend-to-engine-broker`.
9. Engine validates that `BTC` exists.
10. Engine checks Alice's balance.
11. Engine locks the required INR for the buy order.
12. Engine matches against the lowest available sell orders.
13. Engine creates fills for matched trades.
14. Engine updates balances, order status, fills, and order book.
15. Engine pushes this response to `response-queue-backend-1`:

```ts
{
  correlationId: "random-uuid",
  ok: true,
  data: {
    orderId: "order-id",
    status: "filled",
    filledQty: 10,
    fills: []
  }
}
```

16. Backend receives the response.
17. Backend resolves the pending HTTP request using `correlationId`.
18. Backend returns JSON to the client.

## Build Order

1. Finish backend auth and JWT middleware.
2. Add backend Redis client and pending response store.
3. Add engine Redis worker loop.
4. Verify backend to Redis to engine to Redis to backend with a dummy response.
5. Implement engine state types and in-memory store.
6. Implement `get_user_balance`, `get_depth`, and `get_order`.
7. Implement `create_order` matching.
8. Implement `cancel_order`.

## Current Decision

Use Redis queues for backend-to-engine communication, as required by the assignment README.

Do not continue with the temporary HTTP engine idea.

## Future Optimization Notes

- Replace the beginner TypeScript matching scans with a production-grade matching engine data structure later.
- The specific hot path to revisit is best bid / best ask lookup, price-level traversal, and order insertion/removal.
- A later production version could move the matching engine core to C++ or Rust with sorted price levels, FIFO queues per price, and direct best bid / best ask access.
- For the assignment version, keep the TypeScript `Map<number, RestingOrder[]>` implementation because it is easier to reason about and test.
- Replace the current default seeded balances with a real deposit, admin funding, or ledger-backed balance flow later. The assignment version gives new users test INR and asset balances only so order matching can be exercised.
