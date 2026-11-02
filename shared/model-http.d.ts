export declare function transportFailureDetails(
  error: unknown,
): Record<string, string>;
export declare function withTransportRetries<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onRetry?: (details: Record<string, string | number>) => void,
): Promise<T>;
