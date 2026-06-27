import {
  BALANCES,
  STOCKS,
  ORDERBOOKS,
  ORDERS,
  FILLS,
  type Fill,
  type OrderRecord,
  type Balance,
  type Stock,
  type DepthResponse,
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
