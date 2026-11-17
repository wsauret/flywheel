/**
 * Plain-English smell rules for the jev fork's `createJevPlugin`, one per code smell from Martin
 * Fowler's *Refactoring* (2nd ed., chapter 3) that needs judgement rather than syntax.
 * `./fowler-plugin.ts` turns each entry into its own oxlint rule, `anti-slop-martinfowler-jev/<id>`,
 * meant to run at `warn`. "Yes" means
 * "this is the smell". Each question states its carve-outs first and ends with the yes/no
 * question. `message` is the diagnostic text the coding agent reads: it names the smell, says why
 * it matters, and names the refactoring (with its Effect form) to apply.
 *
 * Smells that the AST plugin in `../oxlint-plugin-anti-slop/` detects precisely (Long Function, Long Parameter
 * List, Global Data, Mutable Data, Loops, Message Chains) have no entry here. Mysterious Name and
 * Repeated Switches have both: the AST rules catch the syntactic cases, these catch the ones that
 * need the body or the types read.
 *
 * `"function"` rules send one match per function per rule, and the plugin's `maxMatchesPerFile`
 * caps matches across all of its rules in source order. `martinFowlerJevOptions` sets it above the
 * match count of the largest Flywheel module (about 150 functions times four function rules), and
 * the plugin splits a file's questions over several requests when one request would be too large,
 * so no function goes unchecked. `maxSnippetChars` is above the largest module's size, so no file
 * rule reads a truncated file. `minStatements` keeps one-statement functions, such as forwarding
 * closures, out of the function rules that cannot apply to them, before any request.
 */
import type { JevRule } from "../oxlint-plugin-jev/src/index.ts";

/** A jev rule whose `message` names the smell and the refactoring, so it is required here. */
export type MartinFowlerJevRule = JevRule & { readonly message: string };

/** The oxlint plugin name `./fowler-plugin.ts` registers; each rule is configured as `<name>/<id>`. */
export const martinFowlerJevPluginName = "anti-slop-martinfowler-jev";

/** Plugin-level options sized for these rules: whole-file rules and several function rules. */
export const martinFowlerJevOptions = {
	maxMatchesPerFile: 1000,
	maxSnippetChars: 64_000,
	timeoutMs: 60_000,
} as const;

export const martinFowlerJevRules: ReadonlyArray<MartinFowlerJevRule> = [
	{
		id: "mysterious-name",
		target: "function",
		question:
			"Ignore inline callbacks and test helpers; names fixed by an interface, framework, or library key that the function implements (such as execute, perform, snapshot, fetch, make, layer, or handler); memoization and caches that callers cannot observe; the established idioms ensure, create, resolve, and prepare; and Flywheel lexicon terms used with their defined meaning, such as fold, replay, hydrate, claim, compact, migrate, resume, verify, and validate. Does this function have a durable or external side effect, such as a file write, a deletion, starting or stopping a process or fiber, or a network request, that neither its name nor its doc comment states, so that the name misleads a caller into thinking the function is pure, read-only, or does only one of its steps?",
		cutoff: 0.7,
		message:
			"Possibly Mysterious Name: the name hides a durable or external effect (a file write, a deletion, a process start or stop, or a network request) that callers can observe. Consider Rename Function so the name states every caller-visible step, for example `readSettings` → `readAndMigrateSettings` or `decodeEntry` → `decodeOrQuarantineEntry`, or state the effect in the doc comment.",
	},
	{
		id: "feature-envy",
		target: "function",
		minStatements: 2,
		question:
			"Ignore factory and composition-root functions that build an object by wiring several dependencies; members of a returned object and methods that only delegate to one dependency; mapping and serialization functions at a boundary that translate between two shapes; pure functions over plain data records or schemas; and functions that orchestrate calls to several services in sequence. Does this function mostly read fields of, or call methods on, one other module's object or service (not its own module's state or its own parameters' plain data), so that the logic would be shorter and clearer as an operation of that other module?",
		cutoff: 0.75,
		message:
			"Possibly Feature Envy: this function mostly reads and works on another module's data instead of its own, so changes to that data's rules have to be made here too. Consider Move Function into the module or service that owns the data (in Effect, an operation on that service, so callers yield the service and call it instead of reaching into its fields).",
	},
	{
		id: "data-clumps",
		target: "file",
		question:
			"Ignore groups that a named type, schema, or object already holds; a method signature repeated by the function or class that implements it; variants of one union; protocol messages, stored row shapes, and versioned or historical schemas; pairs of values; and standard positional pairs such as (x, y) or (start, end) that a library API requires separately. Does this file pass the same group of three or more related values (for example organizationId, projectId, and userId, or host, port, and protocol) as separate parameters, or restate them as fields, in two or more declarations that no shared type names, so that the group behaves like one concept without a name?",
		cutoff: 0.7,
		location: {
			question: "Select the first parameter list or declaration where the repeated group of values appears.",
			cutoff: 0.7,
		},
		message:
			"Possibly Data Clumps: the same group of values travels together through several signatures or declarations here, so it is one concept without a name and every new use repeats the group. Consider Introduce Parameter Object or Extract Class (one named interface or type for the group, passed as a single value).",
	},
	{
		id: "primitive-obsession",
		target: "function",
		minStatements: 2,
		question:
			"Ignore identifiers, paths, names, and model ids, which Flywheel keeps as plain strings by design; values whose type is already a literal union or a branded or wrapped type; values from an external format or API compared against that format's own constants; decoders and validators at a boundary; loop counters, sizes, and timestamps; and strings shown only to humans or written to logs. Does this function declare a parameter, field, or return type as a plain string or number while its body compares that value against, or returns, literals from a small fixed set (for example kind: string checked against \"manifest\" and \"proposal\"), or take a boolean parameter that switches between two different behaviors, so that a literal union type or two separate functions would reject invalid values?",
		cutoff: 0.75,
		message:
			"Possibly Primitive Obsession: a plain string, number, or boolean here carries a closed set of values, so an invalid value type-checks. Consider declaring the literal union (or splitting the boolean-flag function in two) so the compiler rejects values outside the set.",
	},
	{
		id: "middle-man",
		target: "file",
		question:
			"Ignore adapters that translate a third-party API into domain types; facades that narrow a large dependency to the few operations callers need; and any operation that adds platform selection, routing, logging, a resolution step, validation, authorization, decoding, error mapping, caching, retries, ownership of a resource, or orchestration of several calls. Does this file define a class, service, or module where every public operation only forwards its arguments unchanged to one method of one dependency and returns its result unchanged?",
		cutoff: 0.75,
		location: {
			question: "Select the first public operation that only forwards to a dependency.",
			cutoff: 0.7,
		},
		message:
			"Possibly Middle Man: most operations here only forward to one dependency, so this layer adds a name and an indirection without adding behavior. Consider Remove Middle Man or Inline Function: let callers use the dependency directly, or move real behavior (validation, mapping, retries) into this layer so it earns its place.",
	},
	{
		id: "lazy-element",
		target: "file",
		question:
			"Ignore exported public API, declarations that give a domain concept its name and are used as a type in several places, functions whose name explains a non-obvious expression, and seams required for testing or dependency injection. Does this file declare a function, class, type, or module-level constant that does so little (for example it wraps a single call or expression, or has one trivial method) and is used in so few places that inlining it at its call sites would be at least as clear?",
		cutoff: 0.75,
		location: {
			question: "Select the declaration that should be inlined at its call sites.",
			cutoff: 0.7,
		},
		message:
			"Possibly Lazy Element: this declaration does almost nothing and has few users, so readers jump to it only to find one call or expression. Consider Inline Function or Inline Class: write its body at the call sites and delete it.",
	},
	{
		id: "speculative-generality",
		target: "file",
		question:
			"Ignore exported library API meant for external callers; parameters required by an interface or callback signature; abstractions with two or more implementations in the codebase (including test implementations that exercise real behavior); options documented as public configuration; test seams such as an injected clock, file system, or client; code ported from an upstream project or listed in a ported-code ledger; and code with a dated removal note. If you cannot name the unused parameter, option, abstraction, hook, or branch and see in this file that no non-test caller uses it, answer no. Does this file contain generality that no current caller uses, such as a parameter or option that every caller omits or passes the same value for, an interface, abstract class, or generic type parameter with exactly one implementation or instantiation, a hook or extension point nothing registers, or a branch for a case that cannot occur?",
		cutoff: 0.75,
		location: {
			question: "Select the unused parameter, option, abstraction, or branch.",
			cutoff: 0.7,
		},
		message:
			"Possibly Speculative Generality: this file carries options, parameters, or abstractions that no current caller needs, so readers maintain flexibility nothing uses. Consider Collapse Hierarchy, Inline Function, Change Function Declaration to drop the unused parameter, or Remove Dead Code.",
	},
	{
		id: "temporary-field",
		target: "file",
		question:
			"Ignore fields that are optional because the data is genuinely optional in the domain; lifecycle handles that are null before start or after dispose; lazily initialized caches with a clear owner; factory and constructor options; per-run state objects; and types that are already discriminated unions. Does this file define a class, record type, or state object that has a discriminator or status field and, beside it, an optional field that is meaningful only for one value of that discriminator or status, so that readers must know the current state to know whether the field is valid?",
		cutoff: 0.75,
		location: {
			question: "Select the declaration of the field that is only valid in one operation or state.",
			cutoff: 0.7,
		},
		message:
			"Possibly Temporary Field: some fields here are only meaningful in one operation or state and empty otherwise, so every reader must know the current state to trust them. Consider Extract Class for the fields and the code that uses them, or split the type into tagged variants (a discriminated union where each variant carries only its own fields).",
	},
	{
		id: "insider-trading",
		target: "file",
		question:
			"Ignore imports of a module's public entry point or exported API, reads of a field that the dependency's published type declarations (its public .d.ts) declare, test files that inspect internals on purpose, and modules in the same package whose sharing is documented. Does this file reach into another module's internals, for example by importing from its internal or private paths, reading or writing its private or underscore-prefixed fields, depending on its internal data layout, or mutating state that module owns, instead of going through that module's public interface?",
		cutoff: 0.75,
		message:
			"Possibly Insider Trading: this module depends on another module's internals, so neither can change its private structure without breaking the other. Consider Move Function so the logic lives with the data it needs, or Hide Delegate so the other module exposes one public operation for what this code uses (in Effect, a service operation instead of reaching into its implementation).",
	},
	{
		id: "data-class",
		target: "file",
		question:
			"Ignore schema and record types that are plain data by design (Schema.Struct, Schema.Class or Data.Class used as values, DTOs, wire or database row types, configuration records, and tagged-union variants), and types whose rules are enforced by a schema. Does this file define a class that has getters and setters or public mutable fields but little or no behavior of its own, while code elsewhere in this file reads and changes its fields to apply rules that belong to that data?",
		cutoff: 0.75,
		location: {
			question: "Select the declaration of the class whose behavior lives elsewhere.",
			cutoff: 0.7,
		},
		message:
			"Possibly Data Class: this class only holds fields and accessors while the rules for its data live in other code, so those rules are scattered and easy to bypass. Consider Move Function to put that behavior on the class, and Encapsulate Record to stop exposing mutable fields; if the type is meant to be plain data, model it as a readonly interface or type instead.",
	},
	{
		id: "comments",
		target: "function",
		question:
			"Ignore comments that state a rationale, a constraint, a trade-off, an invariant, a safety argument (SAFETY: and similar), a removal date, or an external or stored format; doc comments on exported or public APIs; license headers; lint directives; and TODO comments. Does this function contain a comment that restates what the next lines do, labels a section of a long body (such as '// step 1: load' or '// validate input'), or decodes a magic value, where a named constant, an extracted well-named function, or a renamed variable would make the comment unnecessary?",
		cutoff: 0.9,
		message:
			"Possibly Comments: these comments narrate what the code does, which means the code is not saying it itself. Consider Extract Function named after each commented step, Rename Variable or Rename Function so the name carries the explanation, or Introduce Assertion for a commented assumption; keep only comments that explain why.",
	},
	{
		id: "repeated-switches",
		target: "file",
		question:
			"Ignore exhaustive switches over a TypeScript discriminated union whose missing case the compiler reports (a never or assertNever default, a satisfies Record over the union, or a return type that every case must produce); tests that check for one single case to narrow a value, such as an early return when kind is not \"x\", or a filter, find, or type guard for one kind; tests on different unions that only share a field name such as kind; and decoding or encoding of an external protocol at its one boundary. Does this file, in two or more separate places, branch on or list the same two or more cases of the same union (a switch, an if/else chain, a ternary chain, or a condition such as kind === \"a\" || kind === \"b\"), so that adding or moving a case requires editing each place and the compiler would not report a place that was missed?",
		cutoff: 0.7,
		location: {
			question: "Select the second switch or conditional chain over the same union.",
			cutoff: 0.7,
		},
		message:
			"Possibly Repeated Switches: two places here each enumerate the same cases of one union without a compiler check, so a new case can be handled in one place and silently missed in the other. Consider one `satisfies Record<Kind, Handler>` table that both places read, or make each place an exhaustive switch with a `never` default.",
	},
];
