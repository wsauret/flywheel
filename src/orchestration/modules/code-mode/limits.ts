/** Every bound one Code Mode invocation runs under. The host owns time,
 *  results, and previews; the guest receives only the bounds it enforces
 *  itself. The heap budget is a sampled soft budget on the growth of the
 *  Worker's heap past the baseline that the guest takes when it starts and
 *  after each reset, not an allocation cap. */
export interface CodeModeLimits {
  readonly timeoutMs: number
  readonly maxToolCalls: number
  readonly maxAggregateResultBytes: number
  readonly maxHeapDeltaBytes: number
  readonly heapSampleMs: number
  readonly maxLogBytes: number
  readonly maxNestedPreviewBytes: number
  readonly logFlushIntervalMs: number
}

export const CODE_MODE_LIMITS: CodeModeLimits = Object.freeze({
  timeoutMs: 300_000,
  maxToolCalls: 50,
  maxAggregateResultBytes: 50 * 1024 * 1024,
  maxHeapDeltaBytes: 512 * 1024 * 1024,
  heapSampleMs: 25,
  maxLogBytes: 50 * 1024,
  maxNestedPreviewBytes: 50 * 1024,
  logFlushIntervalMs: 50,
})
