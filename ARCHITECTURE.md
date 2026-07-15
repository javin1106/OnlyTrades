# CEX Assignment Architecture

This project follows the boilerplate README architecture:

```text
Browser Client / Postman
  -> Backend API on port 3000
  -> Redis Stream: backend-to-engine-stream
  -> Engine worker process
  -> Backend-specific response List
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
- CORS allowlisting, security headers, and route rate limits
- consistent JSON HTTP errors
- idempotency-key handling and bounded create-order retries
- appending engine commands to a Redis Stream
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

- backend appends command messages with `XADD`
- engine reads them through a consumer group with `XREADGROUP`
- engine acknowledges completed commands with `XACK`
- interrupted commands remain pending and can be reclaimed with `XAUTOCLAIM`
- engine pushes response messages
- backend pops responses and matches them with `correlationId`

## Exact Create Order Workflow

Example request:

```http
POST /order
Authorization: Bearer alice-token
Content-Type: application/json
Idempotency-Key: order-attempt-uuid

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
5. Backend uses the supplied idempotency key, or generates one for this order attempt.
6. Backend creates a message:

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
    qty: 10,
    idempotencyKey: "order-attempt-uuid"
  }
}
```

7. Backend appends that message to Redis Stream `backend-to-engine-stream`.
8. Backend waits for a response with the same `correlationId`.
9. Engine receives the message through Redis consumer group `matching-engine-group`.
10. Engine checks the user and idempotency key before processing.
11. Engine validates that `BTC` exists and checks Alice's balance.
12. Engine locks the required INR for the buy order.
13. Engine matches against the lowest available sell orders.
14. Engine creates fills and updates balances, order status, and the order book.
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

16. Engine acknowledges the command with `XACK` and removes the transport entry.
17. Backend resolves the pending HTTP request using `correlationId`.
18. If the response is uncertain, the backend retries with the same idempotency key.
19. Backend returns JSON to the client.

## Persistence And Failure Behavior

The command transport is recoverable, but exchange state is not durable yet.

| Event | What survives | What is lost or interrupted |
| --- | --- | --- |
| Browser refresh | PostgreSQL users and all running engine state | React memory, unsaved form state, query cache, and the active HTTP connection |
| Backend restart | PostgreSQL users, Redis Stream entries, and engine state if the engine stays running | Pending HTTP promises and active client requests |
| Engine restart | PostgreSQL users and Redis commands, subject to Redis persistence | In-memory balances, orders, fills, books, and idempotency records |
| PostgreSQL restart | Stored users, assuming normal database disk persistence | Active database connections reconnect |
| Redis restart | Data only if Redis AOF/RDB persistence is configured | Otherwise Streams, pending entries, and response Lists |

A browser refresh does not erase an order that the running engine already accepted. However, the browser may lose the response while that order still completes. The frontend must store the pending payload and idempotency key in `sessionStorage`, then retry that exact intent after reload until the result is known.

Redis Streams solve command-delivery recovery. They do not reconstruct balances or books after an engine restart. Durable orders, fills, balance-ledger events, and snapshots are still required for that.

## Frontend Architecture Plan

### Stack

- React and TypeScript with [Vite](https://vite.dev/guide/)
- Tailwind CSS for design tokens and layout
- [shadcn/ui](https://ui.shadcn.com/docs/installation/vite) for source-owned accessible primitives
- [React Router](https://reactrouter.com/home) for pages and protected routes
- [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview) for API state, caching, polling, and invalidation
- [React Hook Form](https://react-hook-form.com/) with Zod for order and authentication forms
- [TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/) for the market chart
- [Lucide React](https://lucide.dev/) for one consistent icon family

Use React state and context first. Do not add Zustand or Redux until client-only state becomes difficult to manage. Orders, balances, depth, fills, and stocks are server state and belong in TanStack Query.

### Folder Structure

```text
frontend/
  src/
    app/
      providers.tsx
      router.tsx
    api/
      client.ts
      auth.api.ts
      exchange.api.ts
    components/
      ui/
      exchange/
    features/
      auth/
      market/
      orders/
      portfolio/
    hooks/
    pages/
      auth-page.tsx
      trade-page.tsx
      orders-page.tsx
      portfolio-page.tsx
    types/
      api.types.ts
    styles/
      globals.css
```

### Trading Screen

```text
+---------------------------------------------------------------+
| Brand | Markets | Search | Connection | Portfolio | Profile   |
+----------+--------------------------------------+--------------+
| Markets  | Instrument header                    | Order book   |
| BTC      +--------------------------------------+--------------+
| ETH      | Price / trade chart                  | Order ticket |
| SOL      |                                      | Buy / Sell   |
+----------+--------------------------------------+--------------+
| Open orders | Order history | Recent fills | Balances         |
+---------------------------------------------------------------+
```

Core exchange components:

- `AppShell`, `TopNavigation`, and `MarketRail`
- `InstrumentHeader` and `ConnectionStatus`
- `PriceChart`, initially built from recent fills
- `OrderBook` with bids, asks, spread, and depth bars
- `OrderTicket` with limit/market and buy/sell modes
- `ConfirmOrderDialog` before financial submission
- `RecentTrades`, `OpenOrdersTable`, and `PortfolioPanel`

### Visual Direction

Use an institutional dark theme rather than a neon gaming dashboard:

- near-black canvas, graphite panels, subtle one-pixel borders
- off-white primary text and restrained muted text
- green only for buy/positive state, red only for sell/negative state
- one violet or cool-blue brand accent
- Geist or Inter for UI and JetBrains Mono for prices and quantities
- tabular numbers, compact tables, deliberate spacing, and minimal gradients
- skeleton loading, empty states, keyboard focus, and restrained motion

The desktop terminal is the primary layout. Tablet stacks the order book and ticket; mobile uses tabs for Chart, Book, Trade, and Orders instead of shrinking the desktop grid.

### Data Ownership

| Data | Owner | Refresh behavior |
| --- | --- | --- |
| JWT session | `sessionStorage` plus Auth context | Survives refresh in the same tab |
| Selected symbol | URL route, such as `/trade/BTC` | Survives refresh and is shareable |
| Stocks, depth, fills, orders, balances | TanStack Query | Cache resets, then refetches from the backend |
| Order form fields | React Hook Form | Reset unless intentionally saved |
| Submitted order payload and idempotency key | `sessionStorage` until resolved | Retried safely after timeout or refresh |
| Theme | `localStorage` | Survives browser restarts |

Until WebSockets exist, poll depth and fills every 1 to 2 seconds and account data every 5 seconds. After create or cancel succeeds, invalidate orders, balance, depth, and fills immediately.

For this assignment, `sessionStorage` is a practical fit for the existing Bearer JWT API and survives a same-tab refresh. A production exchange should move toward short-lived access tokens and secure, HttpOnly cookie-based refresh handling to reduce token exposure to browser scripts.

### Safe Order Submission

1. Validate the form locally.
2. Generate one UUID for this order intent.
3. Save the frozen payload and UUID in `sessionStorage`.
4. Disable the submit button and show a pending state.
5. Send `Idempotency-Key: <uuid>`.
6. Retry only network failures and `503` responses with the same UUID.
7. On a known success or business rejection, clear the pending intent.
8. Refetch orders, balances, depth, and fills.

Do not optimistically display an order as accepted before the engine confirms it.

### Component Sourcing Rules

Use shadcn/ui for Button, Input, Tabs, Dialog, Dropdown, Tooltip, Sheet, Skeleton, Toast, and Table primitives. These components are copied into `components/ui`, so their source and styling remain under project control.

Wrap primitives in domain components such as `OrderTicket` and `OpenOrdersTable`. Use TradingView Lightweight Charts only for chart rendering and Lucide only for icons. Do not mix several complete UI kits such as Material UI, Chakra, Ant Design, and shadcn because their spacing, themes, and interaction patterns will fight each other.

Before importing any external component:

1. Check its license and dependencies.
2. Preview or inspect the source.
3. Copy it into the correct ownership folder.
4. Replace hardcoded colors with project design tokens.
5. Verify keyboard interaction, loading, error, and empty states.
6. Keep one local wrapper so the rest of the app does not depend directly on a third-party API.

### Implementation Phases

1. Scaffold Vite React TypeScript, Tailwind, routing, query provider, and theme tokens.
2. Build signup/signin, Auth context, protected routes, and session restoration.
3. Build the responsive app shell, market selector, instrument header, and API client.
4. Add depth, fills, balances, and orders using TanStack Query polling.
5. Implement the safe order ticket, confirmation dialog, retry state, and cancellation.
6. Add the trade-price chart, tables, skeletons, empty states, and responsive layouts.
7. Run accessibility, error-state, refresh-recovery, and end-to-end checks.
8. Later replace polling with WebSocket market updates and add persistent OHLCV candles.

## Current Decision

Use Redis Streams for reliable command delivery and Redis Lists for temporary correlated responses.

Do not continue with the temporary HTTP engine idea.

## Future Optimization Notes

- Replace the beginner TypeScript matching scans with a production-grade matching engine data structure later.
- The specific hot path to revisit is best bid / best ask lookup, price-level traversal, and order insertion/removal.
- A later production version could move the matching engine core to C++ or Rust with sorted price levels, FIFO queues per price, and direct best bid / best ask access.
- For the assignment version, keep the TypeScript `Map<number, RestingOrder[]>` implementation because it is easier to reason about and test.
- Replace the current default seeded balances with a real deposit, admin funding, or ledger-backed balance flow later. The assignment version gives new users test INR and asset balances only so order matching can be exercised.
