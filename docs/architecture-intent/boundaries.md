# Boundaries Architecture Intent

This file states how Flywheel normalizes external input, keeps its own state strict, and handles secrets.

## ARCH-BOUNDARIES-001: Liberal at external boundaries, strict inside

External input, such as user config, provider streams, model tool-call arguments, network and SDK responses, and subprocess output, may vary. One boundary adapter accepts recoverable variation, normalizes it once into Flywheel's canonical typed shape, and returns a clear typed error when meaning is missing, ambiguous, or unsafe. Once data is Flywheel-owned state, current writers, workflow control, and post-recovery execution parse it strictly. Tolerant parsing exists only at external normalization and at the historical recovery boundary.
Not: Repair, normalization, or legacy branches on internal data downstream of its writer.

## ARCH-BOUNDARIES-002: Normalization lives in the adapter and repairs only clear meaning

Tolerance belongs in the boundary adapter, never in downstream consumers, and what the adapter publishes satisfies the internal contract. The adapter repairs only syntax, framing, ordering, or representation damage whose meaning is unambiguous; otherwise it rejects the input or routes it through an explicit retry or clarification path, and it never invents intent or defaults. Raw external evidence may be kept for audit but never becomes an alternate source of truth. Data that Flywheel sends to an external system uses the narrowest complete documented shape.
Not: Handling provider or model quirks after canonicalization, or relying on a receiver's tolerance for malformed output.

## ARCH-BOUNDARIES-004: The writer enforces invariants and the reader fails loudly

One strict schema gates every write before append, with no passthrough fields and no default on a field that the current producer always sets. Store constraints and workflow control gates reject illegal writes, and cross-event invariants live with the writer. Readers of owned facts, projections, workflow views, conversation trees, handoffs, and internal IPC treat malformed input as an invariant violation that names the position, the fact type, and a producer hint.
Because: A substrate that silently swallows malformed facts cannot honestly support replay, fork, or diff, and a default on an always-set field hides a writer that stopped setting it.
Not: Tolerant parsing, silent empty results, or skipped rows when reading Flywheel's own store.

## ARCH-BOUNDARIES-005: Durable user state is converted, never discarded

Credentials, model preferences, saved provider catalogs, configuration keys, and model and provider identifiers belong to the user and outlive the binary. A change to one of their shapes ships one dated, idempotent conversion beside the owning store, which runs under that store's lock before any reader opens the file. A reader that meets an unknown shape warns and publishes nothing it did not read. Internal strictness never licenses treating user state as empty.

## ARCH-BOUNDARIES-006: Rebuildable caches convert first and never publish empty state

A rebuildable cache converts a known previous shape in place before its first read. A cache that is unreadable and cheap to rebuild may be rebuilt, and the rebuild is recorded, but its owner never silently publishes empty state.

## ARCH-BOUNDARIES-007: A workflow file is an external boundary

A workflow file is untrusted external input. It is read once, bounded in size, from inside the launching session's workflow directory without following links, and parsed without unbounded alias expansion. A boundary repair applies only to a mistake with exactly one reading and reports a warning; an ambiguous mistake is a refusal.

## ARCH-BOUNDARIES-008: External packages are untrusted at every crossing

An external skill package is untrusted content that stays the source of its own bytes (ARCH-CONTEXT-023) under the contained-directory authority of ARCH-DIRECTORIES-012. Each load binds the package to the identity it was read from, and no package byte is used unless it comes from that bound identity; a platform that cannot bind this way serves no filesystem package. Its prompt contribution is marked as third-party data whose provenance never names a local absolute path, and no helper from a package outlives its run as a durable copy. A package entry in an external skill root may be a directory link that a person placed there. The load follows that one link, binds the package to the target directory's identity, and reads every byte below it under the contained-directory authority. Flywheel's skill writes never pass through such a link.
Not: Vendoring or translating external package bodies into local skills.

## ARCH-BOUNDARIES-009: Secrets stay redacted outside one crossing

API keys, OAuth tokens, credentials, the runtime identity key, the push signing key, and live pairing secrets are held redacted in memory from their earliest resolution point. They are unwrapped only at the adapter that makes the provider call, at the signing step, or at one explicit serialization boundary that converts through a plain typed record, so every crossing is intentional. No secret appears in errors, traces, logs, or snapshots. Log scrubbing is defense in depth, not the primary guard.

## ARCH-BOUNDARIES-010: Secrets are redacted at egress before the conversation tree

Secrets are redacted at the egress boundary before content reaches the conversation tree, the provider prompt, audit records, or rendered output. Provider deliberation is the one exception, and durable deliberation can retain secret text for the life of the project store.
Because: Masking provider deliberation breaks same-provider replay.

## ARCH-BOUNDARIES-011: Each output channel is redacted as one whole stream

Each output channel of a tool is redacted as one whole stream before it is combined with other channels, so the framing of one channel cannot change redaction in another. Structured output is redacted after it is decoded, so an encoding escape cannot hide a secret from the redactor.

## ARCH-BOUNDARIES-012: External logins keep their secrets outside Flywheel

A program that owns an external login runs the sign-in and stores and refreshes its token. Flywheel never reads, stores, copies, logs, or sends that token or its credential store, reads only the program's token-free account record, and passes a pasted code straight to the program without keeping it. The runtime credential of an external login is the location of that login, which is not a secret.

## ARCH-BOUNDARIES-013: Request evidence holds only declared nonsensitive config

A configuration section enters request evidence only through a nonsensitive projection that the section explicitly declares over its own schema, and request evidence is frozen at the provider request boundary and read back only through the owning section's schema. Undeclared sections and secret sections never enter request evidence. Client settings use a separate declared UI-safe projection.
Not: Copying whole configuration sections into request evidence or client snapshots.

## ARCH-BOUNDARIES-014: Published config snapshots carry no secrets or authored content

A published config snapshot is secret-free. Its diagnostics carry only a closed setting identity from the setting catalog and a reason, never prose, authored paths or values, decode exceptions, or credentials. Raw retained values, document-wide diagnostics, and diagnostics for settings outside the catalog stay inside the runtime boundary.

## ARCH-BOUNDARIES-015: Notification facts carry only a closed presentation contract

A notification fact holds only curated presentation fields: source, title, message, severity, an optional action from a closed variant set, optional source-session provenance, and timestamps. It never carries commands, raw UI payloads, errors, credentials, account subject data, runtime instance identity, or raw provider errors, and an account-targeted action carries only provider identity and opaque correlation identity.
Because: Durable presentation history must not become an arbitrary command, error, or secret channel.
