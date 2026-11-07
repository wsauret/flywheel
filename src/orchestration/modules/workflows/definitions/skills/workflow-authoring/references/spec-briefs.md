# Specification Briefs

Read this when you write a brief for a phase that turns a settled design into an implementation-ready specification.

## Wiring checklist

- **Method.** Compose `implementation-planning` for milestones, paths, symbols, scenarios, and proof. Add `research` only for ground that the design and inputs do not cover. Pass any supplied map as input. The research protocol owns breadth and limits investigation to gaps.
- **Parent.** The agent settles new technical uncertainty itself, with evidence. Escalate a choice that belongs to the person, or evidence that contradicts the Design intent, to the parent.
- **Intent.** Keep approved Design intent and Decisions in the conversation checkpoint. The runtime carries them to every agent read-only; do not copy them into launch descriptions or briefs. Everything the spec adds is implementation design that a later phase may revise.
- **Authorities.** Name binding documents under PROJECT CONTEXT PATHS in the launch `description`. Return their repository-relative paths in `consulted`, except source files and repository instructions. Forward that list through `reads: [<spec phase>]` to later phases and their reviewers as PROJECT CONTEXT PATHS.
- **Commitments.** Declare `commitments` for obligations that tasks and acceptance criteria do not already state. Each one is one concrete obligation with a check that names a file, a test, a command, or an exact symbol. One strong commitment on the riskiest integration point is better than several weak ones. Write no generic quality advice, and promise no impossible diff property, such as "only additions", when imports, wiring, or test setup must change. An optional review refines them; implementation accounts for them (`review-briefs.md`, `implement-briefs.md`).
- **Readiness.** A ready spec has no open questions and no discovery or experiment milestone. It maps each requirement and success criterion to work and proof. The output says ready or names what is missing. After a failed explorer, continue with the remaining evidence and keep the gap in the output. Continuing does not prove the claim that lost its evidence.
- **Investigation only.** Declare open questions as output. The chat closes them before implementation; an investigation result does not silently become an implementation brief.
- **Read-only.** Use no `persona`, and permit only the `explorer` persona, never `implementer`. Write the spec, drafts, and experiments only in session scratch. Give explorers read-only questions, not requests for files.
- **Grounding.** Pass the repository revision and bind the spec to it. Verify each cited existing path and symbol. Give a concrete reason for the shape and record each rejected alternative with its reason. Do not manufacture alternatives. Each non-obvious element names the requirement or repository trigger that admits it. A deferred concern keeps the assumption that would admit it.
- **Output.** Declare one output contract (SKILL.md section 5). Use `output.submit: file` for a long spec. Keep rationale in its declared fields, with no extra fields or sidecars.

## Skeleton

```yaml
id: spec-change
name: Spec the change
input:
  fields:
    revision: { type: string, description: The commit that the design applies to. }
phases:
  - phase: spec
    dependencies: [implementation-planning]
    brief: >-
      Turn the design in the Design intent of the request into an implementation-ready spec for the repository at revision.
      Everything that you add is implementation design.
      Read each of the PROJECT CONTEXT PATHS. Change no project file: write experiments only in session scratch, and give explorers only read-only questions.
      Settle new technical uncertainty yourself, with evidence. Escalate a choice that belongs to the person, or evidence that contradicts the Design intent, to your parent.
    output:
      summary: What the spec builds, and whether it is ready.
      fields:
        spec: { type: string }
        ready: { type: boolean }
        commitments:
          type: list
          of:
            type: object
            fields:
              commitment: { type: string }
              check: { type: string, description: "The file, test, command, or symbol that proves it." }
        consulted: { type: list, of: { type: string }, description: "Project documents read, except source files and the repository instructions." }
```
