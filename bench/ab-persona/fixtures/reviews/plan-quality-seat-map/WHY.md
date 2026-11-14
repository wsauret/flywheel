# plan-quality-seat-map: seeded defect rationale

## house-state-missing (summary, phase-1/t1, phase-1/t2)

REQUEST.md lists four states and says a house seat "is never offered for sale online". The plan's summary speaks of held and sold seats only, and phase-1/t1 defines `SeatState = "free" | "held" | "sold"` with the rule "every other seat is free". Today getSeatMap blocks house seats through `houseSeatIds`, and the plan's own key_files says so, but the new classification never mentions them. As planned, a house seat is free, and phase-1/t2 then gives it an enabled button with data-seat on the booking site, so it can be sold. The plan covers three of the four required states, and the missing one also breaks the request's "nothing else about booking changes".

## kiosk-consumer-missed (key_files, phase-1/t1)

The plan removes `taken` from the response and names web/seat-map.ts as "the consumer of the seat map response". README.md describes a second consumer: the kiosk app in kiosk/, built from this repository and calling the same API. kiosk/seat-picker.ts declares its own `KioskSeat` with `taken: boolean` and filters `!seat.taken`. Because it reads JSON and does not import `SeatMapResponse`, the compiler does not see the change; after it, `taken` is undefined, and every seat, sold ones included, is offered to the counter staff. tests/kiosk.test.ts builds its own data with `taken`, so `bun test` stays green. The plan's verification cannot reveal the break.

## What is intended

- One phase on purpose: README.md says web/ deploys with the API, and the plan keeps the response change and the grid change together.
- "Sold wins over a hold" is correct and stated with its reason.
- An expired hold leaves a seat free, as today, and a test covers it.
