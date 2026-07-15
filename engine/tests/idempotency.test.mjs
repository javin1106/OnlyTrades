import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelOrder,
  createOrder,
  getDepth,
  getUserBalance,
} from "../dist/services/exchange.service.js";
import {
  BALANCES,
  FILLS,
  IDEMPOTENCY_KEYS,
  ORDERBOOKS,
  ORDERS,
} from "../dist/store/exchange.store.js";

function resetExchangeState() {
  BALANCES.clear();
  FILLS.length = 0;
  IDEMPOTENCY_KEYS.clear();
  ORDERBOOKS.clear();
  ORDERS.clear();
}

test("same key and payload returns the original order without double locking", () => {
  resetExchangeState();

  const input = {
    userId: "buyer-1",
    type: "limit",
    side: "buy",
    symbol: "BTC",
    price: 100,
    qty: 2,
    idempotencyKey: "order-attempt-1",
  };

  const first = createOrder(input);
  const second = createOrder(input);
  const balance = getUserBalance(input.userId);

  assert.equal(second.orderId, first.orderId);
  assert.equal(ORDERS.size, 1);
  assert.equal(balance.INR.available, 99_800);
  assert.equal(balance.INR.locked, 200);
  assert.deepEqual(getDepth("BTC").bids, [{ price: 100, qty: 2 }]);
});

test("same key cannot be reused for a different order payload", () => {
  resetExchangeState();

  createOrder({
    userId: "buyer-1",
    type: "limit",
    side: "buy",
    symbol: "BTC",
    price: 100,
    qty: 2,
    idempotencyKey: "order-attempt-1",
  });

  assert.throws(
    () =>
      createOrder({
        userId: "buyer-1",
        type: "limit",
        side: "buy",
        symbol: "BTC",
        price: 100,
        qty: 3,
        idempotencyKey: "order-attempt-1",
      }),
    /already used for a different order/,
  );

  assert.equal(ORDERS.size, 1);
});

test("replaying cancellation returns the same cancelled order", () => {
  resetExchangeState();

  const order = createOrder({
    userId: "buyer-1",
    type: "limit",
    side: "buy",
    symbol: "BTC",
    price: 100,
    qty: 2,
    idempotencyKey: "cancel-replay-order",
  });

  const firstCancellation = cancelOrder(order.userId, order.orderId);
  const replayedCancellation = cancelOrder(order.userId, order.orderId);
  const balance = getUserBalance(order.userId);

  assert.equal(replayedCancellation.orderId, firstCancellation.orderId);
  assert.equal(replayedCancellation.status, "cancelled");
  assert.equal(balance.INR.available, 100_000);
  assert.equal(balance.INR.locked, 0);
});
