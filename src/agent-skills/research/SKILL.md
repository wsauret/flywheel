---
description: Use when investigating a broad or unfamiliar question from authoritative sources.
---

# Research

Start with one research question, its scope and constraints, and known source boundaries. Decompose it into non-overlapping subquestions. Enumerate plausible authoritative sources before deep reading. Inspect enough primary evidence to answer each subquestion, cite every material claim, reconcile contradictions through underlying source and recency, and distinguish verified fact, inference, and unresolved gap. Prefer empirical evidence over static reasoning: analyze available data, run actual code paths, and use focused experiments in scratch when they can answer the question more reliably than code reading alone. Consolidate the answer around the original question.

This skill owns the research explorer dispatch: whether to dispatch explorers at all, how to split the question into facets, what each explorer brief carries, and how their findings consolidate. The protocol below states that method; a caller composes it and does not restate or override it. When you can launch a workflow file, run an explorer dispatch of two or more facets as one workflow instead of explorer subagents: one phase with one agent for each facet over the launch input, a `dedupe` join by source, and a synthesis phase, as the Research shape of `workflow-authoring` shows.

{{ref:research-protocol}}

## High-risk domains

Security, payments, cryptography, migrations, and privacy always need primary documentation (library docs, maintainer guidance, OWASP for security topics). Record a confirmed claim's source beside the claim. When a source contradicts a claim or a referenced version has breaking changes, research a valid shape instead of carrying the claim forward. A best practice from those sources is a candidate constraint: it enters the work only when the design or the codebase cites it and the selected remedy is the simplest feature-complete shape. An authoritative recommendation alone does not justify new tasks, guards, layers, or scenarios.

## Stopping and reporting

Stop when every subquestion is answered or explicitly unresolved and another source would not proportionately change the decision. Return findings by subquestion, citations, contradictions and resolutions, explicit gaps, and the direct answer.

If sources are unavailable, conflicting without a deciding authority, or outside the permitted boundary, return the exact gap and cheapest next evidence.