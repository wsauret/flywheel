import type { EventBus, MemberEvent } from "./bus.ts";

export interface ClientSocket {
  send(text: string): void;
}

/** Push membership events to every connected client of the event's team.
 *  Clients refetch the team roster when they receive one. */
export function attachNotifier(bus: EventBus, socketsForTeam: (teamId: string) => readonly ClientSocket[]): void {
  bus.subscribe((event: MemberEvent) => {
    const text = JSON.stringify(event);
    for (const socket of socketsForTeam(event.teamId)) socket.send(text);
  });
}
