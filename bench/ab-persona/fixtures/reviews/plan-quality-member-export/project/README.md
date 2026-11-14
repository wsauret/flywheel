# clubdesk

Membership administration for the Kestrel Valley Cycling Club.

- `src/members.ts` is the member store. Club officers edit member details in the admin screens; the payment sync sets each member's status from the payment provider every hour.
- `src/settings.ts` is a small key-value store for the service's own state.
- `src/federation/client.ts` uploads files to the regional federation's member registry.
- `src/scheduler.ts` runs the nightly jobs.

Tests run with `bun test`.
