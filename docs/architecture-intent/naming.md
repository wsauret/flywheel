# Naming Architecture Intent

This file states how Flywheel names its concepts and the grammars for facts, requests, and identifiers.

## ARCH-NAMING-001: One concept, one name

Every Flywheel concept has exactly one canonical name, and every reserved word has exactly one meaning across all Flywheel-owned code, documents, and interface text. A concept's name renders mechanically on each surface but never changes words. Vocabulary that an external API owns is exempt where that API owns it.
Because: Exact search stays reliable only when one spelling addresses one concept, so agents and reviewers do not pay to rule out false candidates.

## ARCH-NAMING-002: The glossary owns names

The glossary owns the names and spellings of concepts, and the statement that owns a concept owns its semantics. When a statement's wording conflicts with the glossary, the glossary wins and the statement adopts the glossary term when it is next rewritten.

## ARCH-NAMING-003: A new concept is named before it lands

A new domain noun or coined word receives a glossary entry before its first identifier lands. The entry states the canonical name, a one-sentence definition, the surfaces the name appears on, and the reserved words it must not collide with. Review rejects a change that introduces a domain noun the glossary does not carry.

## ARCH-NAMING-004: Retired terms do not return

A term that the glossary retires does not appear in new code, documents, or interface text. Where stored data carries a retired spelling, readers translate it at the historical boundary and do not spread the old word inward.

## ARCH-NAMING-005: Stored names are immutable data

Fact type strings, stored field keys, and stored identifier segments keep their spelling permanently and stay readable. The naming grammars bind only newly minted names.
Because: Rewriting stored names needs migrations across every store for no semantic gain and puts existing sessions at risk.
Not: Renaming historical fact types or stored keys to match the current grammar.

## ARCH-NAMING-006: Events and facts keep separate words

Event names only an ephemeral in-process bus message, and fact names only a durable typed row; the durable row type, its writers, and the files that define it carry the fact stem. Snapshot names only a full-state protocol payload and never appears in a fact name. Diagnostic record keys never take the dotted shape of a fact type.
Because: Facts are durable authority and events are delivery, and one shared word blurs the boundary between them.
Not: One event vocabulary for both the bus and the store.

## ARCH-NAMING-007: Fact type grammar

A fact type is lowercase dot-delimited snake_case segments: a domain first, then a subject that can nest further segments for a nested authority, then a past-tense verb, because a fact states what happened. Dots impose no segment limit, underscores join words inside a segment, and language keywords are not domains. Bus event names also use lowercase dot-delimited segments: a domain, then an action.

## ARCH-NAMING-008: Protocol request grammar

A client-to-runtime request is a query or a mutation, never a command. Its type string uses the fact segment grammar with an imperative final verb, so tense alone distinguishes a request from the fact it causes. The word command belongs only to slash commands.

## ARCH-NAMING-009: One concept id derives every surface spelling

One concept id derives each surface spelling mechanically: snake_case for config keys and fact segments, camelCase for values and PascalCase for types in TypeScript, kebab-case for role, module, and skill ids and CLI flags, and screaming snake case with the product prefix for environment variables. A setting has one id, and its config key, accessor, protocol field, and label all derive from it.
Not: A parallel row id, store key, or label key beside the setting's one id.

## ARCH-NAMING-010: An exported name is the shortest unique search address

An exported name is the shortest name that exact search resolves to its one concept: a generic verb names its object, and a domain word joins only when the unqualified name collides. Product names and construction stages do not appear in type names. A read with several filters takes one filter object and does not encode the conjunction in its name.

## ARCH-NAMING-011: Historical shapes are named by version

A decoder of a stored historical version carries that version in its name, and a retired unversioned format carries the word Retired. Legacy is not a name prefix; only names local to a migration call the historical shape that it decodes legacy.

## ARCH-NAMING-012: A selectable feature bundle is a module

A selectable feature bundle is a module, and its config key, protocol domain, and settings section derive from the module id. Plugin names only the external marketplace product, and capability names only an admission grant.
Because: Modules are internal and static (ARCH-STRUCTURE-009), so an external extension word misdescribes them.
Not: Plugin or capability as the noun for a module.

## ARCH-NAMING-013: One vocabulary names the directory values

Production interfaces name the user data root, the project root, and the execution directory by their canonical names and store none of them under another alias. The name cwd appears only at a direct platform call or as the external selection input.
