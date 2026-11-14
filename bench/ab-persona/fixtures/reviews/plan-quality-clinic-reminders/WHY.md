# plan-quality-clinic-reminders: seeded defect rationale

## normalize-phone-does-not-validate (key_files, phase-2/t1)

The plan says normalizePhone "turns a typed mobile number into the E.164 form the gateway needs and returns null when the input is not a valid mobile number", and phase-2/t1 builds the request's most expensive rule on that: "A null result covers both the missing and the invalid number, so no separate validation is needed." src/patients/phone.ts is one line that removes spaces, dashes, dots, and parentheses; its return type is `string`. It never returns null, never checks length or prefix, and adds no country code. With the planned code, every patient with any mobile text gets an SMS, and REQUEST.md says the gateway bills every attempt. The plan even lists the scenario that would expose this ("12345" gets no SMS), which makes the plan look complete while the design under it cannot pass that test. The claim is about existing code and is false, so this is an ungrounded claim.

## time-zone-test-cannot-detect-change (phase-1/t1, phase-1/t2)

Requirement 3 changes formatSlot from fixed UTC to the clinic's zone. Every test the plan gives for that change uses Europe/London on 12 January 2027. London keeps GMT, UTC+0, in winter, so 09:30Z is 09:30 local. The old `timeZone: "UTC"` formatter gives the same text, so a broken implementation that ignored the parameter would pass all planned tests. The plan says the first scenario "proves the clinic's time zone is applied", which it cannot. A zone or date with a non-zero offset would detect it.

## What is intended

- Sending the SMS inside the existing pass, before markReminded, is the plan's way to keep one pass per appointment; it reuses the marker, and it is correct.
- formatSlot really has one caller (the email body), so the required parameter needs no other update.
- The C reply is out of scope by the request's own words.
- A failed SMS send is caught by the pass's existing per-appointment try/catch and reported through reportFailure, so it cannot stop the pass for other appointments. The appointment then stays unmarked, but the next pass's 15-minute window starts where this one ended, so it is not picked again and no second email goes out.
