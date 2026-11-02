export interface RetryState {
  providerSessionKey?: string;
  isRetry: boolean;
  requestContext?: string;
}
