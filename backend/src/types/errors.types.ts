export class CorsOriginError extends Error {
  constructor(origin: string) {
    super(`Origin is not allowed: ${origin}`);
    this.name = "CorsOriginError";
  }
}

export class EngineTransportError extends Error {
  constructor(cause: unknown) {
    super("Could not send command to the exchange engine", { cause });
    this.name = "EngineTransportError";
  }
}
