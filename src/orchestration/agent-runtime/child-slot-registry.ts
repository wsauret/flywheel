const DEFAULT_CHILD_CONCURRENCY_LIMIT = 10;

export interface ChildSlotReservation {
  release(): void;
}

/** Result of asking for a slot. `acquired` grants immediately. `queued` means
 *  every slot is busy: the promise resolves with a reservation in FIFO order
 *  as running children release. `cancel()` withdraws a still-queued request
 *  and rejects the promise; once the grant has landed it is a no-op. */
type ChildSlotAcquisition =
  | { status: "acquired"; reservation: ChildSlotReservation }
  | {
      status: "queued";
      /** 1-based place in the wait queue at dispatch time. */
      position: number;
      limit: number;
      reservation: Promise<ChildSlotReservation>;
      cancel(): void;
    };

export interface ChildSlotRegistry {
  acquire(): ChildSlotAcquisition;
}

export function createChildSlotRegistry(
  limit = DEFAULT_CHILD_CONCURRENCY_LIMIT,
): ChildSlotRegistry {
  let active = 0;
  const waiting: Array<(reservation: ChildSlotReservation) => void> = [];

  function makeReservation(): ChildSlotReservation {
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        // Hand the freed slot to the oldest waiter; `active` only drops when
        // nobody is waiting, so the count always equals granted reservations.
        const next = waiting.shift();
        if (next) {
          next(makeReservation());
          return;
        }
        active--;
      },
    };
  }

  return {
    acquire(): ChildSlotAcquisition {
      if (active < limit) {
        active++;
        return { status: "acquired", reservation: makeReservation() };
      }
      const { promise, resolve, reject } = Promise.withResolvers<ChildSlotReservation>();
      waiting.push(resolve);
      return {
        status: "queued",
        position: waiting.length,
        limit,
        reservation: promise,
        cancel(): void {
          const idx = waiting.indexOf(resolve);
          if (idx === -1) return;
          waiting.splice(idx, 1);
          reject(new Error("dispatch cancelled while queued for a child slot"));
        },
      };
    },
  };
}