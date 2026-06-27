export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order"
  | "get_orders"
  | "get_fills"
  | "get_stocks";

// Outbound message to the engine
export interface EngineRequest {
  correlationId: string;
  responseQueue: string; // where engine should send response
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

// Inbound receipt
export interface EngineResponse {
  correlationId: string;
  ok: boolean; // engine not running on web-server, can't send HTTP codes
  data?: unknown;
  error?: string;
}
