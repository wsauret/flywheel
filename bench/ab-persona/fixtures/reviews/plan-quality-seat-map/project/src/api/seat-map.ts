import type { SeatStore } from "../seats";

export interface SeatMapSeat {
  readonly id: string;
  readonly row: string;
  readonly number: number;
  /** True when the seat cannot be picked: it is held, sold, or a house seat. */
  readonly taken: boolean;
}

export interface SeatMapResponse {
  readonly eventId: string;
  readonly seats: readonly SeatMapSeat[];
}

/** GET /events/:eventId/seats */
export async function getSeatMap(store: SeatStore, eventId: string, now: number): Promise<SeatMapResponse> {
  const [seats, holds, sold, house] = await Promise.all([
    store.seatsFor(eventId),
    store.holdsFor(eventId),
    store.soldSeatIds(eventId),
    store.houseSeatIds(eventId),
  ]);
  const blocked = new Set([
    ...holds.filter((hold) => hold.expiresAt > now).map((hold) => hold.seatId),
    ...sold,
    ...house,
  ]);
  return {
    eventId,
    seats: seats.map((seat) => ({ id: seat.id, row: seat.row, number: seat.number, taken: blocked.has(seat.id) })),
  };
}
