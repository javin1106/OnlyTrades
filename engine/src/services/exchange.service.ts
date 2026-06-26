import { BALANCES, STOCKS, type Balance } from "../store/exchange.store.js";

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
