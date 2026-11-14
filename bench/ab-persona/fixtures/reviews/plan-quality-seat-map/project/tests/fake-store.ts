import type { Hold, Seat, SeatStore } from "../src/seats";

export function fakeStore(input: { seats: Seat[]; holds?: Hold[]; sold?: string[]; house?: string[] }): SeatStore {
  return {
    seatsFor: async () => input.seats,
    holdsFor: async () => input.holds ?? [],
    soldSeatIds: async () => input.sold ?? [],
    houseSeatIds: async () => input.house ?? [],
  };
}
