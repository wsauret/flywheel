export interface Seat {
  readonly id: string;
  readonly row: string;
  readonly number: number;
}

export interface Hold {
  readonly seatId: string;
  /** Epoch milliseconds; an expired hold no longer blocks the seat. */
  readonly expiresAt: number;
}

export interface SeatStore {
  seatsFor(eventId: string): Promise<readonly Seat[]>;
  holdsFor(eventId: string): Promise<readonly Hold[]>;
  soldSeatIds(eventId: string): Promise<readonly string[]>;
  /** Seats the theatre keeps back for the performance. */
  houseSeatIds(eventId: string): Promise<readonly string[]>;
}
