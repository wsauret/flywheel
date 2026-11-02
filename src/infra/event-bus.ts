import { Effect, Exit, PubSub, Scope, Stream } from "effect";
import { awaitWithAbortSignal } from "./abort.js";
import { errorMessage } from "./error-message.js";
import { probeLoopUnit } from "./event-loop-lag.js";
import type {
  FlywheelEvent,
  FlywheelEventData,
  FlywheelEventFor,
  FlywheelEventType,
} from "./events.js";
import { Log } from "./log.js";

type TypedListener<T extends FlywheelEventType> = (event: FlywheelEventFor<T>) => void;
export type Unsubscribe = () => void;

export type Listener = (event: FlywheelEvent) => void;
export type EventDeliveryClass = "critical" | "durable" | "trace" | "ui" | "diagnostic";

interface DeliveryWaiter {
  readonly deliveryClass: EventDeliveryClass;
  readonly promise: Promise<void>;
  resolve(): void;
}

interface Delivery {
  readonly id: number;
  readonly event: FlywheelEvent;
  readonly waiters: Map<symbol, DeliveryWaiter>;
  reliableWaiters: number;
}

interface Subscriber {
  readonly id: symbol;
  readonly label: string;
  readonly deliveryClass: EventDeliveryClass;
  readonly listener: Listener;
  readonly scope?: Scope.Closeable;
  readonly ownedPubsub?: PubSub.PubSub<Delivery>;
  active: boolean;
}

interface TypeGroup {
  readonly types: ReadonlySet<FlywheelEventType>;
  readonly subscribers: Set<Subscriber>;
  readonly pubsub: PubSub.PubSub<Delivery>;
}

function waiter(deliveryClass: EventDeliveryClass): DeliveryWaiter {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { deliveryClass, promise, resolve };
}

function reliableSubscribers(subscribers: readonly Subscriber[]): Subscriber[] {
  return subscribers.filter((sub) => sub.deliveryClass !== "diagnostic");
}

function diagnosticSubscribers(subscribers: readonly Subscriber[]): Subscriber[] {
  return subscribers.filter((sub) => sub.deliveryClass === "diagnostic");
}

export interface EventSubscriptionOptions {
  readonly deliveryClass: EventDeliveryClass;
  readonly delivery?: "pubsub" | "direct";
  readonly label?: string;
}

export type EventBusDrainResult =
  | { readonly kind: "drained" }
  | { readonly kind: "timed_out"; readonly pending: number };

const log = Log.create({ service: "event-bus" });
const DEFAULT_QUEUE_CAPACITY = 2048;
const DIAGNOSTIC_DRAIN_TIMEOUT_MS = 250;
const DRAIN_POLL_MS = 1;
const DRAIN_CLASSES: readonly EventDeliveryClass[] = ["critical", "durable", "trace", "ui"];

/** Effect's bounded atomic PubSub with storage that grows with its backlog.
 *  Effect's own bounded PubSub preallocates two arrays of `capacity` slots,
 *  and a process holds one bus per running agent, each with several PubSubs.
 *  This one stores each unread delivery in a node, as the unbounded PubSub
 *  does, and reports full at `capacity`, so the back-pressure and dropping
 *  strategies act exactly as they act on a bounded PubSub. */
function growingBoundedPubSub<A>(capacity: number): PubSub.PubSub.Atomic<A> {
  const backlog = PubSub.makeAtomicUnbounded<A>();
  const publish = (value: A): boolean => backlog.size() < capacity && backlog.publish(value);
  return {
    capacity,
    isEmpty: () => backlog.isEmpty(),
    isFull: () => backlog.size() >= capacity,
    size: () => backlog.size(),
    publish,
    publishAll: (elements) => {
      const surplus: A[] = [];
      for (const element of elements) if (surplus.length > 0 || !publish(element)) surplus.push(element);
      return surplus;
    },
    slide: () => backlog.slide(),
    subscribe: () => backlog.subscribe(),
    replayWindow: () => backlog.replayWindow(),
  };
}

/** A reliable class waits for capacity; the diagnostic class drops at capacity. */
function deliveryPubSub(deliveryClass: EventDeliveryClass, capacity: number): PubSub.PubSub<Delivery> {
  return Effect.runSync(PubSub.make<Delivery>({
    atomicPubSub: () => growingBoundedPubSub(capacity),
    strategy: () => deliveryClass === "diagnostic" ? new PubSub.DroppingStrategy() : new PubSub.BackPressureStrategy(),
  }));
}

export class EventBus {
  private readonly capacity: number;
  // Most buses never take a wildcard subscriber, so these open on the first one.
  private wildcard: PubSub.PubSub<Delivery> | undefined;
  private diagnosticWildcard: PubSub.PubSub<Delivery> | undefined;
  private readonly typed = new Map<FlywheelEventType, PubSub.PubSub<Delivery>>();
  private readonly diagnosticTyped = new Map<FlywheelEventType, PubSub.PubSub<Delivery>>();
  private readonly wildcardSubscribers = new Set<Subscriber>();
  private readonly typedSubscribers = new Map<FlywheelEventType, Set<Subscriber>>();
  private readonly directTyped = new Map<FlywheelEventType, Set<Subscriber>>();
  private readonly groups = new Set<TypeGroup>();
  private readonly pending = new Map<number, Delivery>();
  private readonly subscriberShutdowns = new Set<Promise<void>>();
  private nextDeliveryId = 0;
  private disposed = false;
  private refusedSubscriptions = 0;
  private reliablePending = 0;
  private capacityWait: { promise: Promise<void>; resolve(): void } | undefined;

  constructor(options: { readonly capacity?: number } = {}) {
    this.capacity = options.capacity ?? DEFAULT_QUEUE_CAPACITY;
  }

  /** Diagnostic wildcard subscription. Production consumers should prefer
   * explicit type sets so their delivery policy is named at the seam. */
  subscribe(listener: Listener, options: EventSubscriptionOptions = { deliveryClass: "diagnostic" }): Unsubscribe {
    if (options.delivery === "direct") {
      throw new Error("direct wildcard subscriptions are not supported; use explicit event types");
    }
    if (this.refusesAfterDispose(options, "*")) return () => {};
    const pubsub = options.deliveryClass === "diagnostic"
      ? this.diagnosticWildcard ??= deliveryPubSub("diagnostic", this.capacity)
      : this.wildcard ??= deliveryPubSub(options.deliveryClass, this.capacity);
    return this.subscribePubSub(pubsub, this.wildcardSubscribers, listener, options, "*");
  }

  subscribeToType<T extends FlywheelEventType>(
    type: T,
    listener: TypedListener<T>,
    options: EventSubscriptionOptions = { deliveryClass: "durable" },
  ): Unsubscribe {
    // SAFETY: TypedListener<T> accepts FlywheelEventFor<T>; the pubsub keyed by
    // `type` only ever delivers events whose `.type === type`, so every event this
    // listener receives is in fact a FlywheelEventFor<T>. The widening to Listener
    // erases that per-type narrowing the dispatch map re-establishes at delivery.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: dispatch by the matching event type makes the narrowed listener safe
    const wrapped = listener as Listener;
    if (this.refusesAfterDispose(options, type)) return () => {};
    if (options.delivery === "direct") return this.subscribeDirect(type, wrapped, options);
    const set = this.subscribersFor(type);
    const pubsub = this.pubsubFor(type, options.deliveryClass);
    return this.subscribePubSub(pubsub, set, wrapped, options, type);
  }

  subscribeToTypes(
    types: readonly FlywheelEventType[],
    listener: Listener,
    options: EventSubscriptionOptions,
  ): Unsubscribe {
    if (options.delivery === "direct") {
      // SAFETY: a wildcard Listener accepts the whole FlywheelEvent union, so it
      // is a valid TypedListener<T> for every T by contravariance; the `never`
      // collapses the per-call T that inference would otherwise pin to one literal.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: wildcard listener accepts every member of the event union
      const unsubs = types.map((type) => this.subscribeToType(type, listener as never, options));
      return () => { for (const unsub of unsubs) unsub(); };
    }
    if (this.refusesAfterDispose(options, "types")) return () => {};
    const pubsub = deliveryPubSub(options.deliveryClass, this.capacity);
    const group: TypeGroup = { types: new Set(types), subscribers: new Set(), pubsub };
    this.groups.add(group);
    const unsubscribe = this.subscribePubSub(pubsub, group.subscribers, listener, options, options.label ?? "types", true);
    return () => { this.groups.delete(group); unsubscribe(); };
  }

  emit(event: FlywheelEvent): void {
    if (this.disposed) return;
    const direct = [...(this.directTyped.get(event.type) ?? [])].filter((sub) => sub.active);
    const wildcard = [...this.wildcardSubscribers].filter((sub) => sub.active);
    const typed = [...(this.typedSubscribers.get(event.type) ?? [])].filter((sub) => sub.active);
    const groups = [...this.groups].filter((group) => group.types.has(event.type));
    const delivery = this.delivery(event, [...direct, ...wildcard, ...typed, ...groups.flatMap((group) => [...group.subscribers])]);

    for (const sub of direct) void this.invoke(sub, delivery);
    if (this.wildcard) this.publish(this.wildcard, delivery, reliableSubscribers(wildcard));
    if (this.diagnosticWildcard) this.publish(this.diagnosticWildcard, delivery, diagnosticSubscribers(wildcard));
    const typedReliablePubSub = this.typed.get(event.type);
    if (typedReliablePubSub) this.publish(typedReliablePubSub, delivery, reliableSubscribers(typed));
    const typedDiagnosticPubSub = this.diagnosticTyped.get(event.type);
    if (typedDiagnosticPubSub) this.publish(typedDiagnosticPubSub, delivery, diagnosticSubscribers(typed));
    for (const group of groups) this.publish(group.pubsub, delivery, [...group.subscribers]);
  }

  /** Cooperative producer watermark. Call after each input chunk and await
   * only when full, before advancing the source iterator. Synchronous emitters
   * can overshoot by their current work; this does not discard accepted events. */
  waitForCapacity(signal?: AbortSignal): void | Promise<void> {
    if (this.disposed || this.reliablePending < this.capacity) return;
    this.capacityWait ??= Promise.withResolvers<void>();
    return awaitWithAbortSignal(this.capacityWait.promise, signal);
  }

  async drain(options: { readonly timeoutMs?: number; readonly classes?: readonly EventDeliveryClass[] } = {}): Promise<EventBusDrainResult> {
    const started = Date.now();
    const classes = new Set<EventDeliveryClass>(options.classes ?? ["critical", "durable", "trace", "ui", "diagnostic"]);
    while (true) {
      const waiters = this.waitersFor(classes);
      if (waiters.length === 0) return { kind: "drained" };
      const remaining = options.timeoutMs === undefined ? undefined : options.timeoutMs - (Date.now() - started);
      if (remaining !== undefined && remaining <= 0) return { kind: "timed_out", pending: waiters.length };
      const sleepMs = remaining === undefined ? DRAIN_POLL_MS : Math.min(DRAIN_POLL_MS, remaining);
      await Promise.race([Promise.allSettled(waiters.map((pending) => pending.promise)), Bun.sleep(sleepMs)]);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const critical = await this.drain({ classes: DRAIN_CLASSES });
    if (critical.kind === "timed_out") log.warn("critical event drain timed out", { pending: critical.pending });
    const diagnostic = await this.drain({ classes: ["diagnostic"], timeoutMs: DIAGNOSTIC_DRAIN_TIMEOUT_MS });
    if (diagnostic.kind === "timed_out") log.warn("diagnostic event drain timed out", { pending: diagnostic.pending });
    await Promise.allSettled([...this.wildcardSubscribers, ...this.allTypedSubscribers(), ...this.allDirectSubscribers(), ...[...this.groups].flatMap((group) => [...group.subscribers])].map((sub) => this.trackSubscriberShutdown(this.closeSubscriber(sub))));
    await this.awaitSubscriberShutdowns();
    if (this.wildcard) await Effect.runPromise(PubSub.shutdown(this.wildcard));
    if (this.diagnosticWildcard) await Effect.runPromise(PubSub.shutdown(this.diagnosticWildcard));
    for (const pubsub of this.typed.values()) await Effect.runPromise(PubSub.shutdown(pubsub));
    for (const pubsub of this.diagnosticTyped.values()) await Effect.runPromise(PubSub.shutdown(pubsub));
  }

  /** Once disposal starts, nothing would ever shut down a delivery opened for
   *  a new subscriber, so the bus refuses it before it allocates one. */
  private refusesAfterDispose(options: EventSubscriptionOptions, type: string): boolean {
    if (!this.disposed) return false;
    this.refusedSubscriptions++;
    if (this.refusedSubscriptions === 1) {
      log.info("subscription refused after dispose", { listener: options.label ?? type, deliveryClass: options.deliveryClass });
    } else {
      log.debug("subscriptions refused after dispose", { count: this.refusedSubscriptions });
    }
    return true;
  }

  private subscribePubSub(
    pubsub: PubSub.PubSub<Delivery>,
    set: Set<Subscriber>,
    listener: Listener,
    options: EventSubscriptionOptions,
    type: string,
    ownedPubsub = false,
  ): Unsubscribe {
    const scope = Scope.makeUnsafe("sequential");
    const sub: Subscriber = { id: Symbol(type), label: options.label ?? type, deliveryClass: options.deliveryClass, listener, scope, active: true, ...(ownedPubsub ? { ownedPubsub: pubsub } : {}) };
    const subscription = Effect.runSync(Scope.provide(scope)(PubSub.subscribe(pubsub)));
    Effect.runSync(Scope.provide(scope)(Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((delivery) => Effect.promise(() => this.invoke(sub, delivery))),
      Effect.forkScoped,
    )));
    set.add(sub);
    return () => this.unsubscribe(set, sub);
  }

  private subscribeDirect(type: FlywheelEventType, listener: Listener, options: EventSubscriptionOptions): Unsubscribe {
    const set = this.directFor(type);
    const sub: Subscriber = { id: Symbol(type), label: options.label ?? type, deliveryClass: options.deliveryClass, listener, active: true };
    set.add(sub);
    return () => this.unsubscribe(set, sub);
  }

  private unsubscribe(set: Set<Subscriber>, sub: Subscriber): void {
    if (!sub.active) return;
    sub.active = false;
    set.delete(sub);
    void this.trackSubscriberShutdown(this.closeSubscriberAfterDrain(sub));
  }

  private async closeSubscriberAfterDrain(sub: Subscriber): Promise<void> {
    await this.drainSubscriber(sub);
    await this.closeSubscriber(sub);
  }

  private closeSubscriber(sub: Subscriber): Promise<void> {
    if (!sub.scope || sub.scope.state._tag === "Closed") return Promise.resolve();
    return Effect.runPromise(Scope.close(sub.scope, Exit.void))
      .then(async () => { if (sub.ownedPubsub) await Effect.runPromise(PubSub.shutdown(sub.ownedPubsub)); })
      .catch((err) => {
        log.warn("subscriber close failed", { listener: sub.label, deliveryClass: sub.deliveryClass, error: errorMessage(err) });
      });
  }

  private trackSubscriberShutdown(task: Promise<void>): Promise<void> {
    let tracked: Promise<void> = Promise.resolve();
    tracked = task.finally(() => {
      this.subscriberShutdowns.delete(tracked);
    });
    this.subscriberShutdowns.add(tracked);
    return tracked;
  }

  private async awaitSubscriberShutdowns(): Promise<void> {
    while (this.subscriberShutdowns.size > 0) {
      await Promise.allSettled(this.subscriberShutdowns);
    }
  }

  private async invoke(sub: Subscriber, delivery: Delivery): Promise<void> {
    if (!delivery.waiters.has(sub.id)) return;
    try {
      // Probe only the synchronous call: that is the portion that occupies the
      // loop. An async listener's awaited continuations are I/O-bound and are
      // attributed by their own spans, not charged to this subscriber.
      await Promise.resolve(probeLoopUnit("bus-subscriber", sub.label, () => sub.listener(delivery.event)));
    } catch (err) {
      log.warn("listener error", { eventType: delivery.event.type, listener: sub.label, deliveryClass: sub.deliveryClass, error: errorMessage(err) });
    } finally {
      this.ack(delivery, sub.id);
    }
  }

  private publish(pubsub: PubSub.PubSub<Delivery>, delivery: Delivery, subscribers: readonly Subscriber[]): void {
    if (subscribers.length === 0) return;
    void Effect.runPromise(PubSub.publish(pubsub, delivery))
      .then((accepted) => {
        // A rejected publish (dropping pubsub at capacity, or a bus shutting
        // down) must still ack, or drain() would wait forever on deliveries
        // that can never reach their subscribers.
        if (!accepted) for (const sub of subscribers) this.ack(delivery, sub.id);
      })
      .catch((err) => {
        log.warn("publish failed", { eventType: delivery.event.type, error: errorMessage(err) });
        for (const sub of subscribers) this.ack(delivery, sub.id);
      });
  }

  private delivery(event: FlywheelEvent, subscribers: readonly Subscriber[]): Delivery {
    const delivery: Delivery = { id: ++this.nextDeliveryId, event, waiters: new Map(), reliableWaiters: 0 };
    for (const sub of subscribers) {
      delivery.waiters.set(sub.id, waiter(sub.deliveryClass));
      if (sub.deliveryClass !== "diagnostic") delivery.reliableWaiters++;
    }
    if (delivery.reliableWaiters > 0) this.reliablePending++;
    if (delivery.waiters.size > 0) this.pending.set(delivery.id, delivery);
    return delivery;
  }

  private ack(delivery: Delivery, id: symbol): void {
    const pendingWaiter = delivery.waiters.get(id);
    if (!pendingWaiter) return;
    delivery.waiters.delete(id);
    pendingWaiter.resolve();
    if (pendingWaiter.deliveryClass !== "diagnostic" && --delivery.reliableWaiters === 0) {
      this.reliablePending--;
      if (this.reliablePending < this.capacity) {
        this.capacityWait?.resolve();
        this.capacityWait = undefined;
      }
    }
    if (delivery.waiters.size === 0) this.pending.delete(delivery.id);
  }

  private waitersFor(classes: ReadonlySet<EventDeliveryClass>): DeliveryWaiter[] {
    return [...this.pending.values()].flatMap((delivery) => [...delivery.waiters.values()].filter((pending) => classes.has(pending.deliveryClass)));
  }

  private async drainSubscriber(sub: Subscriber): Promise<void> {
    const waiters = [...this.pending.values()].map((delivery) => delivery.waiters.get(sub.id)).filter((pending): pending is DeliveryWaiter => pending !== undefined);
    if (waiters.length > 0) await Promise.allSettled(waiters.map((pending) => pending.promise));
  }

  private pubsubFor(type: FlywheelEventType, deliveryClass: EventDeliveryClass): PubSub.PubSub<Delivery> {
    const map = deliveryClass === "diagnostic" ? this.diagnosticTyped : this.typed;
    let pubsub = map.get(type);
    if (!pubsub) {
      pubsub = deliveryPubSub(deliveryClass, this.capacity);
      map.set(type, pubsub);
    }
    return pubsub;
  }

  private subscribersFor(type: FlywheelEventType): Set<Subscriber> {
    let set = this.typedSubscribers.get(type);
    if (!set) {
      set = new Set();
      this.typedSubscribers.set(type, set);
    }
    return set;
  }

  private directFor(type: FlywheelEventType): Set<Subscriber> {
    let set = this.directTyped.get(type);
    if (!set) {
      set = new Set();
      this.directTyped.set(type, set);
    }
    return set;
  }

  private allTypedSubscribers(): Subscriber[] {
    return [...this.typedSubscribers.values()].flatMap((set) => [...set]);
  }

  private allDirectSubscribers(): Subscriber[] {
    return [...this.directTyped.values()].flatMap((set) => [...set]);
  }
}

type EmitInput<T extends FlywheelEventType> = {
  readonly sessionId: string;
  readonly data: FlywheelEventData<T>;
  readonly id?: string;
  readonly timestamp?: number;
  readonly causality?: FlywheelEvent["causality"];
};

export type EmitFn = <T extends FlywheelEventType>(
  type: T,
  input: EmitInput<T>,
) => void;

/** Builds each event's envelope and hands it to `target`, which is a bus or
 *  a sole consumer that needs no bus. */
export function createEmit(target: Pick<EventBus, "emit">): EmitFn {
  return (type, input) => {
    // SAFETY: `type` and `input.data: FlywheelEventData<T>` are bound to the same T,
    // so the envelope is exactly the FlywheelEventFor<T> member; the union FlywheelEvent
    // cannot be inferred from a generically-assembled object whose discriminant is a
    // type parameter, so the cast re-states the type<->data pairing the signature enforces.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: generic type and data parameters preserve the event union correlation
    target.emit({
      id: input.id ?? crypto.randomUUID(),
      type,
      sessionId: input.sessionId,
      timestamp: input.timestamp ?? Date.now(),
      data: input.data,
      ...(input.causality ? { causality: input.causality } : {}),
    } as FlywheelEvent);
  };
}
