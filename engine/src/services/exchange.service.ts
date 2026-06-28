import {
  BALANCES,
  STOCKS,
  ORDERBOOKS,
  ORDERS,
  FILLS,
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

export function createOrder(input: CreateOrderInput): OrderRecord {
  if (input.type !== "limit") {
    throw new Error("Market orders are not implemented yet");
  }

  assertStockExists(input.symbol);
  const balances = getUserBalance(input.userId);

  if (input.side === "buy") {
    const requiredMoney = input.price * input.qty;
    const availableMoney = balances.INR;

    if (!availableMoney) {
      throw new Error("INR Balance is missing");
    }

    if (availableMoney.available < requiredMoney) {
      throw new Error("Insufficient INR balance");
    }

    availableMoney.available -= requiredMoney;
    availableMoney.locked += requiredMoney;

    const bestPrice = bestAskPrice(input.symbol);
    if (bestPrice && bestPrice.price <= input.price) {
      console.log("Buy order can match with ask: ", bestPrice);
    }
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

    const bestPrice = bestBidPrice(input.symbol);
    if (bestPrice && bestPrice.price >= input.price) {
      console.log("Sell order can match with bid: ", bestPrice);
    }
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
  return order;
}

// Replace this O(n) best-price scan with optimized price-level data structures later.
function bestAskPrice(
  symbol: string,
): { price: number; orders: RestingOrder[] } | null {
  const orderBook = ORDERBOOKS.get(symbol);
  if (!orderBook) return null;

  let bestPrice: number | null = null;
  let bestOrders: RestingOrder[] = [];

  for (const [price, orders] of orderBook.asks.entries()) {
    const activeOrders = orders.filter(
      (order) => order.qty - order.filledQty > 0, // still have quantity left, no empty quantity
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
): { price: number; orders: RestingOrder[] } | null {
  const orderBook = ORDERBOOKS.get(symbol);
  if (!orderBook) {
    return null;
  }

  let bestPrice: number | null = null;
  let bestOrders: RestingOrder[] = [];

  for (const [price, orders] of orderBook.bids.entries()) {
    const activeOrders = orders.filter(
      (order) => order.qty - order.filledQty > 0, // still have quantity left, no empty quantity
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
