export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  onRetry?: (error: unknown, nextAttempt: number, delayMs: number) => void;
}

export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }

  if (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs < 0) {
    throw new Error("baseDelayMs must be a non-negative number");
  }

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === options.maxAttempts) {
        throw error;
      }

      const delayMs = options.baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(error, attempt + 1, delayMs);

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error("Retry operation ended unexpectedly");
}
