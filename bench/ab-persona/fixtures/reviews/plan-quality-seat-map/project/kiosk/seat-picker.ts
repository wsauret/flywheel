// The kiosk reads the seat map API as JSON over HTTP, so it declares the fields it uses.
interface KioskSeat {
  readonly id: string;
  readonly row: string;
  readonly number: number;
  readonly taken: boolean;
}

interface KioskSeatMap {
  readonly eventId: string;
  readonly seats: readonly KioskSeat[];
}

/** The seats the counter staff may sell, in row and number order. */
export function sellableSeats(map: KioskSeatMap): readonly KioskSeat[] {
  return map.seats
    .filter((seat) => !seat.taken)
    .sort((a, b) => a.row.localeCompare(b.row) || a.number - b.number);
}

export async function loadSeatMap(baseUrl: string, eventId: string): Promise<KioskSeatMap> {
  const response = await fetch(`${baseUrl}/events/${encodeURIComponent(eventId)}/seats`);
  if (!response.ok) throw new Error(`Seat map request failed with ${response.status}`);
  return (await response.json()) as KioskSeatMap;
}
