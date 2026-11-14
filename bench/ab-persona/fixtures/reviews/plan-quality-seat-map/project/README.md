# box-office

Ticketing for the Riverside Playhouse.

- `src/seats.ts` holds the seats of each performance, the holds customers place while they pay, the sold seats, and the house seats the theatre keeps back.
- `src/api/seat-map.ts` serves `GET /events/:eventId/seats`, the seat map API.
- `web/` is the public booking site's seat map. The server serves it, so it deploys with the API.
- `kiosk/` is the box-office kiosk app on the counter machines. It is built from this repository and calls the same seat map API.

Tests run with `bun test`.
