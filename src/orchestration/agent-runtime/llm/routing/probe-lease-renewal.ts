interface ProbeLeaseRenewalOptions {
  readonly intervalMs: number;
  readonly isStopped: () => boolean;
  readonly renew: () => boolean;
  readonly onFailure: (error: unknown) => void;
}

/** Renews one fenced lease until its request concludes or loses ownership. */
export function startProbeLeaseRenewal(options: ProbeLeaseRenewalOptions): () => void {
  let active = true;
  const stop = (): void => {
    if (!active) return;
    active = false;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (!active) return;
    if (options.isStopped()) {
      stop();
      return;
    }
    try {
      if (!options.renew()) stop();
    } catch (error) {
      options.onFailure(error);
      if (options.isStopped()) stop();
    }
  }, options.intervalMs);
  timer.unref?.();
  return stop;
}
