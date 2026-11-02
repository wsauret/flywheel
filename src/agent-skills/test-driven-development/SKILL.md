---
description: Use when a behavior change needs RED, GREEN, and REFACTOR evidence.
---

# Test-Driven Development

A behavior change is complete only when a public-behavior test fails for the intended reason, passes after the least implementation, and remains green through refactoring.

## Input and method

Start with one behavior change or regression and an executable test seam.

1. Find the owner. Search the tests for the one that already asserts this behavior at the strongest boundary. Extend that test or its table when it exists; add a new test only for behavior no existing test asserts. Test the same contract at another layer only for a distinct risk the owner cannot reach, such as transport or lifecycle.
2. Write the smallest test through the public surface.
3. Run RED and confirm the intended failure rather than a typo, missing import, or unrelated setup failure. A negative test must fail for the reason its name states, not for a missing field or another guard.
4. Write the least code that makes the test pass and run GREEN.
5. Refactor only while GREEN remains preserved.
6. Add only contract-relevant edge cases: the implementation's real empty, missing, malformed, duplicate, or boundary branches.

Do not write a test that:

- exercises a copy of production logic written inside the test file;
- greps source text, imports, or identifier spelling;
- restates a constant, declared type, registration, or flag instead of exercising the behavior it promises;
- uses a mock or fixture that implements the behavior it then asserts, or computes its expected value with the code under test;
- replays a shared helper's generic behavior in every caller's suite;
- carries a name that promises more than its assertions check.

When implementation already exists, establish RED against the unchanged baseline or safely isolate only your own change. Never discard other work or reconstruct unavailable history to manufacture evidence. If no test framework exists, use the narrowest repeatable executable behavior check.

Unit tests stay fast and hermetic. By default, protect logic with unit tests and verify a changed real boundary with a dedicated testing script. Place persistent regression tests according to existing test conventions. Do not assume the repository has an integration tier or that integration tests are expensive. If repository instructions specify a different test hierarchy or required gates, follow them.

## Result

Stop with exactly one result:

- `completed`: report test location, the owner test you checked and whether you extended it, exact RED and GREEN commands, exit codes, intended RED reason, passing evidence, and refactor outcome.
- `skipped`: name one allowed category, such as pure refactor with existing coverage, documentation, configuration, or no useful test seam; provide evidence and the narrowest substitute behavior check.
- `blocked`: report why honest RED cannot be established or GREEN cannot be reached, with observed output.

Never claim test-driven proof from GREEN alone. Hard-to-test code is not itself a skip reason; when extraction creates a useful public seam without changing scope, that extraction is part of the change.