{
  "schema_version": 1,
  "summary": "Tell held seats from sold seats on the seat map, as REQUEST.md asks. The seat map API replaces the taken flag with a state per seat, and the booking site's seat grid shows each state, with a note on held seats that they may come free in a few minutes.",
  "context": {
    "key_files": [
      "REQUEST.md - The box-office manager's request.",
      "src/api/seat-map.ts - getSeatMap, GET /events/:eventId/seats: seats with a taken flag computed from unexpired holds, sold seats, and house seats.",
      "src/seats.ts - Seat, Hold, and the SeatStore port.",
      "web/seat-map.ts - renderSeatGrid, the booking site's seat grid and the consumer of the seat map response; it imports SeatMapResponse.",
      "tests/seat-map.test.ts, tests/web.test.ts, tests/fake-store.ts - Existing coverage."
    ],
    "patterns": [
      "The API module owns the response type; the web grid imports it.",
      "Tests build stores with fakeStore."
    ],
    "constraints": [
      "The API and web/ deploy together (README.md), so the response change and the grid change land in one release.",
      "Booking rules do not change: only a free seat can be picked.",
      "An expired hold does not block a seat, as today."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "The seat map API and the booking site show held and sold seats apart.",
      "files": [
        "src/api/seat-map.ts",
        "web/seat-map.ts",
        "tests/seat-map.test.ts",
        "tests/web.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "In src/api/seat-map.ts, export `type SeatState = \"free\" | \"held\" | \"sold\"` and replace `taken: boolean` on SeatMapSeat with `state: SeatState`. In getSeatMap, a seat in soldSeatIds is sold; otherwise a seat with an unexpired hold is held; every other seat is free. Sold wins over a hold, because a sale can complete while a stale hold row still exists.",
          "files": [
            "src/api/seat-map.ts",
            "tests/seat-map.test.ts"
          ],
          "test_scenarios": [
            "A sold seat is sold.",
            "A seat with an unexpired hold is held.",
            "A seat whose only hold has expired is free.",
            "A seat that is sold and still has an unexpired hold is sold."
          ]
        },
        {
          "id": "t2",
          "description": "In renderSeatGrid, give each button the class `seat <state>`. Only a free seat gets data-seat and is enabled. A held seat also gets `title=\"May come free in a few minutes\"`.",
          "files": [
            "web/seat-map.ts",
            "tests/web.test.ts"
          ],
          "test_scenarios": [
            "A free seat renders enabled with data-seat.",
            "A held seat renders disabled with the class seat held and the title.",
            "A sold seat renders disabled with the class seat sold and no title."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "Open the seat map of a test performance with one held and one sold seat and check both renderings."
    }
  ],
  "success_criteria": [
    "The seat map API reports each seat's state.",
    "The booking site shows held and sold seats differently and notes that held seats may come free.",
    "Only free seats can be picked.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "GET /events/:eventId/seats returns a state per seat in place of taken.",
        "completion_check": "tests/seat-map.test.ts covers sold, held, expired hold, and sold-with-hold."
      },
      {
        "id": "d2",
        "text": "The booking site's seat grid renders each state.",
        "completion_check": "tests/web.test.ts covers free, held, and sold buttons."
      }
    ]
  }
}
