import type { SeatMapResponse } from "../src/api/seat-map";

/** The seat grid of the booking site: one button per seat, grouped by row. */
export function renderSeatGrid(map: SeatMapResponse): string {
  const rows = new Map<string, string[]>();
  for (const seat of map.seats) {
    const button = seat.taken
      ? `<button class="seat taken" disabled>${seat.row}${seat.number}</button>`
      : `<button class="seat free" data-seat="${seat.id}">${seat.row}${seat.number}</button>`;
    rows.set(seat.row, [...(rows.get(seat.row) ?? []), button]);
  }
  return [...rows].map(([row, buttons]) => `<div class="row" data-row="${row}">${buttons.join("")}</div>`).join("\n");
}
