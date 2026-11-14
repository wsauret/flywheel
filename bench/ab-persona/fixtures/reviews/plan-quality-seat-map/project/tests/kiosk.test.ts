import { expect, test } from "bun:test";
import { sellableSeats } from "../kiosk/seat-picker";

test("the kiosk offers free seats in row and number order", () => {
  const map = {
    eventId: "e-1",
    seats: [
      { id: "b1", row: "B", number: 1, taken: false },
      { id: "a2", row: "A", number: 2, taken: true },
      { id: "a1", row: "A", number: 1, taken: false },
    ],
  };
  expect(sellableSeats(map).map((seat) => seat.id)).toEqual(["a1", "b1"]);
});
