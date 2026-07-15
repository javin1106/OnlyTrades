import type { EngineResponse } from "../types/engine.types.js";

interface PendingResponse {
  resolve: (response: EngineResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const pendingResponses = new Map<string, PendingResponse>();

export class EngineResponseTimeoutError extends Error {
  constructor() {
    super("Engine response timed out");
    this.name = "EngineResponseTimeoutError";
  }
}

export function waitForEngineResponse(
  correlationId: string,
  timeoutMs: number,
): Promise<EngineResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingResponses.delete(correlationId);
      reject(new EngineResponseTimeoutError());
    }, timeoutMs);

    pendingResponses.set(correlationId, {
      resolve,
      reject,
      timeout,
    });
  });
}

export function cancelEngineResponseWait(correlationId: string): void {
  const pending = pendingResponses.get(correlationId);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingResponses.delete(correlationId);
}

export function resolveEngineResponse(response: EngineResponse): void {
  const pending = pendingResponses.get(response.correlationId);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingResponses.delete(response.correlationId);
  pending.resolve(response);
}
