import { expect, test } from "bun:test";
import { getSeatMap } from "../src/api/seat-map";
import { fakeStore } from "./fake-store";

const seats = [
  { id: "a1", row: "A", number: 1 },
  { id: "a2", row: "A", number: 2 },
  { id: "a3", row: "A", number: 3 },
  { id: "a4", row: "A", number: 4 },
  { id: "a5", row: "A", number: 5 },
];

test("held, sold, and house seats are taken; an expired hold is not", async () => {
  const store = fakeStore({
    seats,
    holds: [{ seatId: "a1", expiresAt: 2000 }, { seatId: "a5", expiresAt: 500 }],
    sold: ["a2"],
    house: ["a3"],
  });
  const map = await getSeatMap(store, "e-1", 1000);
  expect(map.seats.map((seat) => [seat.id, seat.taken])).toEqual([
    ["a1", true], ["a2", true], ["a3", true], ["a4", false], ["a5", false],
  ]);
});
