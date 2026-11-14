import { expect, test } from "bun:test";
import { renderSeatGrid } from "../web/seat-map";

test("taken seats render disabled", () => {
  const html = renderSeatGrid({ eventId: "e-1", seats: [{ id: "a1", row: "A", number: 1, taken: true }, { id: "a2", row: "A", number: 2, taken: false }] });
  expect(html).toContain('<button class="seat taken" disabled>A1</button>');
  expect(html).toContain('data-seat="a2"');
});
