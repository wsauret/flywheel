/**
 * Plain-English rules for `oxlint-plugin-jev`'s `createJevPlugin`, encoding the Effect review
 * policy in the upstream `skills/effect-program-design`. `./effect-plugin.ts` turns each entry into its own oxlint
 * rule, `anti-slop-effect-jev/<id>`. "Yes" means "report". Each question states its carve-outs
 * first and ends with the yes/no question.
 *
 * Every rule targets `"file"`. The plugin sends one match per rule per matching node, and
 * `maxMatchesPerFile` caps matches across all of a plugin's rules in source order, so `"call"`
 * and `"function"` rules exhaust the cap on the first few calls or callbacks of an Effect file and
 * leave the rest unchecked. A file rule is one match per file, and `location` still points the
 * diagnostic at the offending line.
 */
import type { JevRule } from "../oxlint-plugin-jev/src/index.ts";

/** The oxlint plugin name `./effect-plugin.ts` registers; each rule is configured as `<name>/<id>`. */
export const effectJevPluginName = "anti-slop-effect-jev";

/**
 * Plugin-level options sized for whole-file rules. A file longer than `maxSnippetChars` is
 * truncated and loses its location, so raise it for repositories with long modules. The file is
 * sent once per request however many file rules read it, so request size is about the file plus
 * one question per enabled rule.
 */
export const effectJevOptions = {
  maxMatchesPerFile: 25,
  maxSnippetChars: 64_000,
  timeoutMs: 60_000,
} as const;

/** For application and library source. Turn these off for test globs. */
export const effectSourceJevRules: ReadonlyArray<JevRule> = [
  {
    id: "single-use-abstraction",
    target: "file",
    question:
      "Count only a non-exported type, interface, schema, object, or function that this file references exactly once. Do not count it when that one reference is a parameter type, a return type, a variable or element type, or a satisfies target, or is an entry of a registry list; do not count a versioned or historical schema, an interface with an index signature, or a declaration with a doc comment. If you cannot name the declaration and the line of its one use, answer no. Does this file contain such a declaration that only renames one other type, groups at most three fields, or passes its arguments unchanged to one call, so that writing it inline at its one use would be at least as clear?",
    cutoff: 0.8,
    location: {
      question: "Select the declaration that should be written inline where it is used.",
      cutoff: 0.7,
    },
  },
  {
    id: "error-as-value",
    target: "file",
    question:
      "Consider only Effect programs: Effect.gen bodies, pipe chains over Effect values, and functions that return an Effect. Ignore every function that does not return an Effect, such as an ordinary synchronous or Promise-returning function whose declared result type is a union like { ok: true, value } | { ok: false, error }. Also ignore absence that is a normal domain outcome, such as a lookup that found nothing; verdict and Option values that are domain outcomes the caller branches on; tool results returned to the model, such as a Result or a ToolResult with an isError flag; local branching on Effect.result or Effect.either that then re-fails or handles each case; aggregates that intentionally collect per-item successes and failures as data; and protocol encoders that serialize an error into a wire response. Does any Effect program in this file report a failure as a successful value, for example by returning or succeeding with { ok: false }, an object with an error or errors field, an Either, Result, or Exit, an Error instance, or null, undefined, or Option.none() meaning that an operation failed, instead of failing in the Effect error channel?",
    cutoff: 0.75,
    location: {
      question: "Select the line that returns or succeeds with the failure value.",
      cutoff: 0.7,
    },
  },
  {
    id: "shallow-service",
    target: "file",
    question:
      "Ignore non-exported adapter helpers; a lifecycle layer whose service is the scoped resource itself; a scoped acquire or dial function that is not a Context.Service; and operations that add validation, authorization, decoding, mapping to domain types, error narrowing, caching, retries, or orchestration of several calls. Adding only a span or a log does not make an operation deep. Does this file define an Effect service (a Context.Service class, its make effect, or the layer implementing it) with a public operation that only calls one method on one dependency and returns that result unchanged, or a public operation whose input or output types include an HTTP or SDK client, a database row or query-builder type, a connection, a token, or a credential?",
    cutoff: 0.75,
    location: {
      question:
        "Select the service operation that only forwards to a dependency or that exposes a client, row, connection, or credential.",
      cutoff: 0.7,
    },
  },
  {
    id: "swallow-without-capture",
    target: "file",
    question:
      "Consider Effect recovery operators (catchTag, catchTags, catch, catchAll, catchCause, orElse, orElseSucceed, ignore, or a similar recovery), try/catch statements, and Promise .catch or rejection handlers. Ignore recovery from expected domain outcomes such as NotFound, AlreadyExists, or a validation failure; handlers that fail or throw again with another error; a recovery whose adjacent comment says why the failure is expected or who records it; a handler that stores the error in state, a field, or a typed result that a caller reads later; a catch on a sequencing tail, such as tail = task.catch(() => {}), while the original effect or promise is still returned to its caller; and a catch whose only job is to stop an unhandled rejection of a promise whose failure is observed elsewhere. Does this file turn a failure into success, by producing void, a default, or a fallback value, without logging or reporting that error either inside the handler or in an earlier tapError in the same pipeline?",
    cutoff: 0.7,
    location: {
      question: "Select the recovery call, catch clause, or .catch handler that discards the error without capturing it.",
      cutoff: 0.7,
    },
  },
  {
    id: "unbounded-retry",
    target: "file",
    question:
      "Ignore repeat of a successful pass, and retry policies that are bounded by attempts or elapsed time and only see retryable errors. Does this file call Effect.retry, Stream.retry, Effect.retryOrElse, or a similar retry operator with a policy that has no bound on attempts or elapsed time (for example a bare Schedule.exponential or Schedule.spaced with no take, recurs, times, or upTo), or that retries every error with no while or until predicate and no earlier narrowing of the error channel to retryable failures?",
    cutoff: 0.7,
    location: {
      question: "Select the retry call with the unbounded or unfiltered policy.",
      cutoff: 0.7,
    },
  },
  {
    id: "network-call-in-transaction",
    target: "file",
    question:
      "Ignore transaction bodies that only read and write the database, and external calls made before the transaction starts or after it commits. Does this file run a database transaction (withTransaction, db.transaction, sql.withTransaction, or a similar transaction wrapper) whose body makes an HTTP, SDK, or model-provider call, publishes or sends a message, or sleeps or retries with backoff?",
    cutoff: 0.7,
    location: {
      question: "Select the external call or wait inside the transaction body.",
      cutoff: 0.7,
    },
  },
  {
    id: "read-then-write-race",
    target: "file",
    question:
      "Ignore reads used only for a response when the write does not depend on them, and code that runs inside one write-locked transaction, such as SQLite BEGIN IMMEDIATE, including a function documented to run inside its caller's transaction. Does this file read a database row's state or existence and then, in a separate statement, conditionally insert or update that same row based on what it read, without a conditional update guarded on the expected prior state, an upsert or onConflict clause, a row lock such as SELECT ... FOR UPDATE, or a unique-claim check on the affected-row count?",
    cutoff: 0.7,
    location: { question: "Select the write that depends on the earlier read.", cutoff: 0.7 },
  },
  {
    id: "unbounded-fanout",
    target: "file",
    question:
      "Ignore fixed literal tuples or records of effects, calls with a fixed numeric concurrency, and calls that omit concurrency and therefore run sequentially. Does this file run Effect.forEach, Effect.all, Stream.mapEffect, or a similar operator over a collection whose size is only known at runtime, where each item does I/O, with concurrency set to \"unbounded\" or to a value derived from the collection's length?",
    cutoff: 0.7,
    location: { question: "Select the call with unbounded concurrency.", cutoff: 0.7 },
  },
  {
    id: "decode-after-status",
    target: "file",
    question:
      "Ignore a function that receives a Response as a parameter, because its caller owns the status check; responses already checked with filterStatusOk, a status match, or a helper that classifies the status; reads of an error body after a non-success status check; OAuth device-authorization and token endpoints, whose error bodies carry protocol state; and parsing of text that does not come from an HTTP response. Does a function in this file obtain an HTTP Response itself and then decode its body into a success schema or parse it as JSON without first checking or classifying its status, or read the same response body more than once?",
    cutoff: 0.7,
    location: {
      question:
        "Select the decode or body read that happens before the status is checked, or the second body read.",
      cutoff: 0.7,
    },
  },
  {
    id: "cache-in-method",
    target: "file",
    question:
      "Ignore files that contain no Effect program (an Effect.gen body, a pipe chain over Effect values, a function that returns an Effect, or a layer or service make); caches constructed once while building a layer, a service make, or a module-level value and then shared; a Map that lives for one call and is reused within that call, such as a memo for a recursion or for one migration pass; and factory functions, such as a create...Cache function, whose returned cache the caller keeps. Does an Effect program in this file create a cache or memo, such as Cache.make, Cache.makeWith, Effect.cached, Effect.cachedWithTTL, or a Map used as a memo, that is built again on every call and so never serves a later call, or hand-build a TTL or in-flight cache from a Map plus timestamps, timers, or stored promises?",
    cutoff: 0.7,
    location: {
      question: "Select the line that constructs the per-call cache or the hand-built cache.",
      cutoff: 0.7,
    },
  },
];

/** For test files only. Enable these for test globs and turn the source rules off there. */
export const effectTestJevRules: ReadonlyArray<JevRule> = [
  {
    id: "test-cannot-fail",
    target: "file",
    question:
      "Count a test that has no assertions, that asserts only on values the test itself constructed, that asserts a mock or fake returns what the test configured it to return, that asserts only facts the type system already guarantees, or whose only assertions run inside a loop over a list that may be empty; do not count tests whose assertions observe the output, error, or end state produced by the code under test. Does this file contain a test case (it, test, it.effect, it.live, it.prop, or a similar test registration) that would still pass if the behavior named in its title were broken or removed?",
    cutoff: 0.7,
    location: {
      question: "Select the title line of the test case that cannot fail.",
      cutoff: 0.7,
    },
  },
];
