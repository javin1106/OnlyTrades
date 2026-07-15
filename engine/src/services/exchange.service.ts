import {
  BALANCES,
  STOCKS,
  ORDERBOOKS,
  ORDERS,
  FILLS,
  IDEMPOTENCY_KEYS,
  type Fill,
  type OrderRecord,
  type CreateOrderInput,
  type Balance,
  type Stock,
  type DepthResponse,
  type RestingOrder,
} from "../store/exchange.store.js";

export function getUserBalance(userId: string): Record<string, Balance> {
  const existingBalance = BALANCES.get(userId);

  if (existingBalance) {
    return existingBalance;
  }

  // lazy update
  const initialBalance: Record<string, Balance> = {
    INR: { available: 100000, locked: 0 },
  };

  for (const stock of STOCKS) {
    initialBalance[stock.symbol] = {
      available: 10,
      locked: 0,
    };
  }

  BALANCES.set(userId, initialBalance);
  return initialBalance;
}

export function getStocks(): Stock[] {
  return STOCKS;
}

function assertStockExists(symbol: string): void {
  const exists = STOCKS.some((stock) => stock.symbol === symbol);

  if (!exists) {
    throw new Error("Unknown symbol");
  }
}

// depth is not stored directly, it is calculated from the private order book => hence the math required
export function getDepth(symbol: string): DepthResponse {
  assertStockExists(symbol);

  const orderBook = ORDERBOOKS.get(symbol);

  if (!orderBook) {
    return {
      symbol,
      bids: [],
      asks: [],
    };
  }

  const bids = Array.from(orderBook.bids.entries())
    .map(([price, orders]) => ({
      price,
      qty: orders.reduce(
        (sum, order) => sum + (order.qty - order.filledQty),
        0,
      ),
    }))
    .filter((level) => level.qty > 0)
    .sort((a, b) => b.price - a.price);

  const asks = Array.from(orderBook.asks.entries())
    .map(([price, orders]) => ({
      price,
      qty: orders.reduce(
        (sum, order) => sum + (order.qty - order.filledQty),
        0,
      ),
    }))
    .filter((level) => level.qty > 0)
    .sort((a, b) => a.price - b.price);

  return { symbol, bids, asks };
}

export function getOrder(userId: string, orderId: string): OrderRecord {
  const order = ORDERS.get(orderId);
  if (!order) {
    throw new Error("Order not found");
  }

  if (order.userId !== userId) {
    throw new Error("Order not found");
  }

  return order;
}

export function getUserOrders(userId: string): OrderRecord[] {
  return Array.from(ORDERS.values())
    .filter((order) => order.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getFills(symbol: string): Fill[] {
  assertStockExists(symbol);

  return FILLS.filter((fill) => fill.symbol === symbol)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50); // return only recent trades not all to be shown
}

export function cancelOrder(userId: string, orderId: string): OrderRecord {
  const order = getOrder(userId, orderId);

  if (order.status === "cancelled") {
    return order;
  }

  if (order.status === "filled") {
    throw new Error("Filled order cannot be cancelled");
  }

  if (order.type !== "limit" || order.price === null) {
    throw new Error("Only resting limit orders can be cancelled");
  }

  const remainingQty = order.qty - order.filledQty;
  if (remainingQty <= 0) {
    throw new Error("Order has no remaining quantity");
  }

  const orderBook = ORDERBOOKS.get(order.symbol);
  if (!orderBook) {
    throw new Error("Order book missing");
  }

  const bookSide = order.side === "buy" ? orderBook.bids : orderBook.asks;
  const priceLevel = bookSide.get(order.price);

  if (!priceLevel) {
    throw new Error("Order is not resting on book");
  }

  const activeOrders = priceLevel.filter(
    (restingOrder) => restingOrder.orderId !== order.orderId,
  );

  if (activeOrders.length === priceLevel.length) {
    throw new Error("Order is not resting on book");
  }

  if (activeOrders.length === 0) {
    bookSide.delete(order.price);
  } else {
    bookSide.set(order.price, activeOrders);
  }

  unlockRemainingReservation(order, remainingQty);
  order.status = "cancelled";

  return order;
}

export function createOrder(input: CreateOrderInput): OrderRecord {
  const idempotencyStoreKey = getIdempotencyStoreKey(input);
  const requestFingerprint = getOrderRequestFingerprint(input);

  if (idempotencyStoreKey) {
    const idempotencyRecord = IDEMPOTENCY_KEYS.get(idempotencyStoreKey);

    if (
      idempotencyRecord &&
      Date.now() - idempotencyRecord.createdAt > IDEMPOTENCY_TTL_MS
    ) {
      IDEMPOTENCY_KEYS.delete(idempotencyStoreKey);
    } else if (idempotencyRecord) {
      if (idempotencyRecord.requestFingerprint !== requestFingerprint) {
        throw new Error(
          "Idempotency-Key was already used for a different order",
        );
      }

      const existingOrder = ORDERS.get(idempotencyRecord.orderId);
      if (!existingOrder) {
        throw new Error("Idempotent order record missing");
      }

      return existingOrder;
    }
  }

  assertStockExists(input.symbol);
  const balances = getUserBalance(input.userId);
  let marketBuyRemainingSpend =
    input.type === "market" && input.side === "buy" ? (input.maxSpend ?? 0) : 0;

  if (input.side === "buy") {
    if (input.type === "limit" && input.price === null) {
      throw new Error("price is required for limit orders");
    }

    if (input.type === "market" && !input.maxSpend) {
      throw new Error("maxSpend is required for market buy orders");
    }

    const requiredMoney =
      input.type === "limit" ? input.price! * input.qty : (input.maxSpend ?? 0);
    const availableMoney = balances.INR;

    if (!availableMoney) {
      throw new Error("INR Balance is missing");
    }

    if (availableMoney.available < requiredMoney) {
      throw new Error("Insufficient INR balance");
    }

    availableMoney.available -= requiredMoney;
    availableMoney.locked += requiredMoney;
  }

  if (input.side === "sell") {
    const assetBalance = balances[input.symbol];
    if (!assetBalance) {
      throw new Error("Asset Balance is missing");
    }

    if (assetBalance.available < input.qty) {
      throw new Error("Insufficient asset balance");
    }

    assetBalance.available -= input.qty;
    assetBalance.locked += input.qty;
  }

  const order: OrderRecord = {
    orderId: crypto.randomUUID(),
    userId: input.userId,
    side: input.side,
    type: input.type,
    symbol: input.symbol,
    price: input.price,
    qty: input.qty,
    filledQty: 0,
    status: "open",
    fills: [],
    createdAt: Date.now(),
  };

  ORDERS.set(order.orderId, order);

  const completeOrder = (): OrderRecord => {
    if (idempotencyStoreKey) {
      IDEMPOTENCY_KEYS.set(idempotencyStoreKey, {
        orderId: order.orderId,
        requestFingerprint,
        createdAt: Date.now(),
      });
    }

    return order;
  };

  if (input.side === "buy") {
    while (order.qty - order.filledQty > 0) {
      const bestPrice = bestAskPrice(input.symbol, order.userId);

      if (!bestPrice) break;
      if (input.type === "limit") {
        if (input.price === null) {
          throw new Error("price is required for limit orders");
        }

        if (bestPrice.price > input.price) break;
      }

      if (input.type === "market" && marketBuyRemainingSpend <= 0) break;

      const restingOrder = bestPrice.orders[0];

      if (!restingOrder) throw new Error("Resting order not available");

      const incomingRemaining = order.qty - order.filledQty;
      const restingRemaining = restingOrder.qty - restingOrder.filledQty;
      let tradeQty = Math.min(incomingRemaining, restingRemaining);

      if (input.type === "market") {
        const maxAffordableQty = marketBuyRemainingSpend / bestPrice.price;
        tradeQty = Math.min(tradeQty, maxAffordableQty);

        if (tradeQty <= 0) break;

        marketBuyRemainingSpend -= bestPrice.price * tradeQty;
      }

      order.filledQty += tradeQty;
      restingOrder.filledQty += tradeQty;

      const restingOrderRecord = ORDERS.get(restingOrder.orderId);
      if (!restingOrderRecord) {
        throw new Error("Resting order record missing");
      }

      restingOrderRecord.filledQty += tradeQty;

      updateOrderStatus(order);
      updateOrderStatus(restingOrderRecord);
      restingOrder.status = restingOrderRecord.status;

      const fill: Fill = {
        fillId: crypto.randomUUID(),
        symbol: input.symbol,
        price: bestPrice.price,
        qty: tradeQty,
        buyOrderId: order.orderId,
        sellOrderId: restingOrder.orderId,
        createdAt: Date.now(),
      };

      FILLS.push(fill);
      order.fills.push(fill);
      restingOrderRecord.fills.push(fill);

      settleFill({
        buyerUserId: order.userId,
        sellerUserId: restingOrder.userId,
        symbol: input.symbol,
        tradePrice: bestPrice.price,
        tradeQty,
        buyerLockedRelease:
          input.type === "limit"
            ? input.price! * tradeQty
            : bestPrice.price * tradeQty,
      });

      const orderBook = ORDERBOOKS.get(input.symbol);
      if (!orderBook) {
        throw new Error("Order book missing");
      }

      cleanupPriceLevel(orderBook.asks, bestPrice.price);
    }
  }

  if (input.side === "sell") {
    while (order.qty - order.filledQty > 0) {
      const bestPrice = bestBidPrice(input.symbol, order.userId);

      if (!bestPrice) break;
      if (input.type === "limit") {
        if (input.price === null) {
          throw new Error("price is required for limit orders");
        }

        if (bestPrice.price < input.price) break;
      }

      const restingOrder = bestPrice.orders[0];

      if (!restingOrder) throw new Error("Resting order not available");

      const incomingRemaining = order.qty - order.filledQty;
      const restingRemaining = restingOrder.qty - restingOrder.filledQty;
      const tradeQty = Math.min(incomingRemaining, restingRemaining);
      order.filledQty += tradeQty;
      restingOrder.filledQty += tradeQty;

      const restingOrderRecord = ORDERS.get(restingOrder.orderId);
      if (!restingOrderRecord) {
        throw new Error("Resting order record missing");
      }

      restingOrderRecord.filledQty += tradeQty;

      updateOrderStatus(order);
      updateOrderStatus(restingOrderRecord);
      restingOrder.status = restingOrderRecord.status;

      const fill: Fill = {
        fillId: crypto.randomUUID(),
        symbol: input.symbol,
        price: bestPrice.price,
        qty: tradeQty,
        buyOrderId: restingOrder.orderId,
        sellOrderId: order.orderId,
        createdAt: Date.now(),
      };

      FILLS.push(fill);
      order.fills.push(fill);
      restingOrderRecord.fills.push(fill);

      settleFill({
        buyerUserId: restingOrder.userId,
        sellerUserId: order.userId,
        symbol: input.symbol,
        tradePrice: bestPrice.price,
        tradeQty,
        buyerLockedRelease: restingOrder.price * tradeQty,
      });

      const orderBook = ORDERBOOKS.get(input.symbol);
      if (!orderBook) {
        throw new Error("Order book missing");
      }

      cleanupPriceLevel(orderBook.bids, bestPrice.price);
    }
  }

  const remainingQty = order.qty - order.filledQty;

  if (
    input.type === "limit" &&
    remainingQty > 0 &&
    wouldCrossOwnRestingOrder(order)
  ) {
    unlockRemainingReservation(order, remainingQty);

    if (order.filledQty === 0) {
      order.status = "cancelled";
    } else {
      updateOrderStatus(order);
    }

    return completeOrder();
  }

  if (input.type === "market") {
    if (input.side === "buy") {
      refundLockedInr(order.userId, marketBuyRemainingSpend);
    }

    if (input.side === "sell" && remainingQty > 0) {
      unlockRemainingReservation(order, remainingQty);
    }

    if (remainingQty > 0 && order.filledQty === 0) {
      order.status = "cancelled";
      return completeOrder();
    }

    updateOrderStatus(order);
    return completeOrder();
  }

  if (remainingQty === 0) {
    return completeOrder();
  }

  if (input.price === null) {
    throw new Error("price is required for resting limit orders");
  }

  let orderBook = ORDERBOOKS.get(input.symbol);
  if (!orderBook) {
    orderBook = {
      bids: new Map(),
      asks: new Map(),
    };
  }

  ORDERBOOKS.set(input.symbol, orderBook);

  const bookSide = input.side === "buy" ? orderBook.bids : orderBook.asks;
  const priceLevel = bookSide.get(input.price) ?? []; // get all orders at that price, if none then start an empty array

  // push the order at that price
  priceLevel.push({
    orderId: order.orderId,
    userId: order.userId,
    side: order.side,
    type: "limit",
    symbol: order.symbol,
    price: input.price,
    qty: order.qty,
    filledQty: order.filledQty,
    status: order.status,
    createdAt: order.createdAt,
  });

  bookSide.set(input.price, priceLevel);
  return completeOrder();
}

// Replace this O(n) best-price scan with optimized price-level data structures later.
function bestAskPrice(
  symbol: string,
  excludedUserId?: string,
): { price: number; orders: RestingOrder[] } | null {
  const orderBook = ORDERBOOKS.get(symbol);
  if (!orderBook) return null;

  let bestPrice: number | null = null;
  let bestOrders: RestingOrder[] = [];

  for (const [price, orders] of orderBook.asks.entries()) {
    const activeOrders = orders.filter(
      (order) =>
        order.qty - order.filledQty > 0 && order.userId !== excludedUserId,
    );

    if (activeOrders.length === 0) continue;
    if (bestPrice === null || price < bestPrice) {
      bestPrice = price;
      bestOrders = activeOrders;
    }
  }

  if (bestPrice === null) {
    return null;
  }
  return { price: bestPrice, orders: bestOrders };
}

function bestBidPrice(
  symbol: string,
  excludedUserId?: string,
): { price: number; orders: RestingOrder[] } | null {
  const orderBook = ORDERBOOKS.get(symbol);
  if (!orderBook) {
    return null;
  }

  let bestPrice: number | null = null;
  let bestOrders: RestingOrder[] = [];

  for (const [price, orders] of orderBook.bids.entries()) {
    const activeOrders = orders.filter(
      (order) =>
        order.qty - order.filledQty > 0 && order.userId !== excludedUserId,
    );

    if (activeOrders.length === 0) continue;
    if (bestPrice === null || price > bestPrice) {
      bestPrice = price;
      bestOrders = activeOrders;
    }
  }

  if (bestPrice === null) {
    return null;
  }
  return { price: bestPrice, orders: bestOrders };
}

function updateOrderStatus(order: OrderRecord): void {
  if (order.filledQty === 0) {
    order.status = "open";
    return;
  }

  if (order.filledQty < order.qty) {
    order.status = "partially_filled";
    return;
  }

  order.status = "filled";
}

function cleanupPriceLevel(
  bookSide: Map<number, RestingOrder[]>,
  price: number,
): void {
  const priceLevel = bookSide.get(price);

  if (!priceLevel) return;

  const activeOrders = priceLevel.filter(
    (order) => order.qty - order.filledQty > 0,
  );

  if (activeOrders.length === 0) {
    bookSide.delete(price);
    return;
  }

  bookSide.set(price, activeOrders);
}

function settleFill(params: {
  buyerUserId: string;
  sellerUserId: string;
  symbol: string;
  tradePrice: number;
  tradeQty: number;
  buyerLockedRelease: number;
}): void {
  const buyerBalances = getUserBalance(params.buyerUserId);
  const sellerBalances = getUserBalance(params.sellerUserId);

  const buyerInr = buyerBalances.INR;
  const buyerAsset = buyerBalances[params.symbol];
  const sellerInr = sellerBalances.INR;
  const sellerAsset = sellerBalances[params.symbol];

  if (!buyerInr || !buyerAsset || !sellerInr || !sellerAsset) {
    throw new Error("Balance missing");
  }

  const lockedToRelease = params.buyerLockedRelease;
  const tradeValue = params.tradePrice * params.tradeQty;
  const refund = lockedToRelease - tradeValue;

  buyerInr.locked -= lockedToRelease;
  buyerInr.available += refund;
  buyerAsset.available += params.tradeQty;

  sellerAsset.locked -= params.tradeQty;
  sellerInr.available += tradeValue;
}

function unlockRemainingReservation(
  order: OrderRecord,
  remainingQty: number,
): void {
  const balances = getUserBalance(order.userId);

  if (order.side === "buy") {
    if (order.price === null) {
      throw new Error("Buy order price missing");
    }

    const inrBalance = balances.INR;
    if (!inrBalance) {
      throw new Error("INR Balance is missing");
    }

    const lockedToUnlock = order.price * remainingQty;
    inrBalance.locked -= lockedToUnlock;
    inrBalance.available += lockedToUnlock;
    return;
  }

  const assetBalance = balances[order.symbol];
  if (!assetBalance) {
    throw new Error("Asset Balance is missing");
  }

  assetBalance.locked -= remainingQty;
  assetBalance.available += remainingQty;
}

function refundLockedInr(userId: string, amount: number): void {
  if (amount <= 0) return;

  const balances = getUserBalance(userId);
  const inrBalance = balances.INR;

  if (!inrBalance) {
    throw new Error("INR Balance is missing");
  }

  inrBalance.locked -= amount;
  inrBalance.available += amount;
}

function getIdempotencyStoreKey(input: CreateOrderInput): string | null {
  if (!input.idempotencyKey) return null;

  return `${input.userId}:${input.idempotencyKey}`;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function getOrderRequestFingerprint(input: CreateOrderInput): string {
  return JSON.stringify({
    type: input.type,
    side: input.side,
    symbol: input.symbol,
    price: input.price,
    qty: input.qty,
    maxSpend: input.maxSpend ?? null,
  });
}

function wouldCrossOwnRestingOrder(order: OrderRecord): boolean {
  if (order.price === null) return false;

  const orderBook = ORDERBOOKS.get(order.symbol);
  if (!orderBook) return false;

  const oppositeBookSide = order.side === "buy" ? orderBook.asks : orderBook.bids;

  for (const [price, restingOrders] of oppositeBookSide.entries()) {
    const hasOwnActiveOrder = restingOrders.some(
      (restingOrder) =>
        restingOrder.userId === order.userId &&
        restingOrder.qty - restingOrder.filledQty > 0,
    );

    if (!hasOwnActiveOrder) continue;

    if (order.side === "buy" && price <= order.price) return true;
    if (order.side === "sell" && price >= order.price) return true;
  }

  return false;
}
