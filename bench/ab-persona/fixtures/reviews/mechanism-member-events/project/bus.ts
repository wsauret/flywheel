export type MemberEvent =
  | { type: "member.added"; teamId: string; userId: string; role: string }
  | { type: "member.removed"; teamId: string; userId: string };

type Listener = (event: MemberEvent) => void;

/** In-process event bus. Delivery is deferred, so a listener never runs on
 *  the emitter's stack and a slow listener cannot delay the emitter. */
export class EventBus {
  private readonly listeners: Listener[] = [];

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  emit(event: MemberEvent): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => listener(event));
    }
  }
}
