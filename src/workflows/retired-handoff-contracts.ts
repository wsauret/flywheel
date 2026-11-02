/** Frozen output grammars of the retired handoff types, for the conversion
 *  of saved workflow files from builds before the step-content cutover.
 *
 *  A saved file from a build before the step-content cutover names a handoff
 *  type on each binding. When the converted step's content declares no
 *  output, the loader gives it the grammar of that type from this table. The
 *  table is history, not a live contract registry: no current definition
 *  names a type, and an edit to a shipped step contract must not change it.
 *  `spec-handoff` is absent on purpose, because a converted step that named it
 *  reads the shipped plan contract `bundled:contracts/implementation-plan.json`.
 *
 *  Remove after 2027-04-30. */

import type { OutputObject } from "./output-contract/grammar.js";

/** The handoff type a converted step reads the shipped plan contract for. */
export const RETIRED_SPEC_HANDOFF = "spec-handoff";
export const SHIPPED_PLAN_CONTRACT = "bundled:contracts/implementation-plan.json";

/** The frozen grammar of each retired handoff type except `spec-handoff`. */
const RETIRED_HANDOFF_CONTRACTS = {
  "work-handoff": {
    summary: "What was done, the completed or replaced phase ids, the verification performed now and its result, and the current state. Name each warning and each file that needs a careful review here.",
    fields: {
      decisions: {"type": "list", "of": {"type": "string"}, "optional": true, "description": "Material revisions of the plan or the low-level design, and why."},
      contract_result: {"type": "object", "optional": true, "description": "Required when the plan carries implementation_contract. Account for every directive.", "fields": {"directives": {"type": "list", "min": 1, "unique": "id", "description": "One entry for each plan directive.", "of": {"type": "variant", "tag": "status", "cases": {"satisfied": {"id": {"type": "string", "description": "The directive id."}, "evidence": {"type": "string", "description": "A test name, file path, command, or symbol."}}, "deviated": {"id": {"type": "string", "description": "The directive id."}, "evidence": {"type": "string", "description": "What was built instead."}, "reason": {"type": "string", "description": "Why."}, "risk": {"type": "enum", "values": ["low", "medium", "high"], "description": "Risk of the deviation."}}, "superseded": {"id": {"type": "string", "description": "The directive id."}, "instruction": {"type": "string", "description": "The quoted instruction that replaced the directive."}, "source": {"type": "enum", "values": ["person", "parent"], "description": "Who gave it."}}}}}}},
    },
  },
  "debug-handoff": {
    summary: "Concise result of the completed stage.",
    fields: {
      stage: {"type": "enum", "values": ["investigation", "fix", "verification"], "description": "Completed stage: investigation, fix, or verification."},
      hypothesis: {"type": "string", "nullable": true, "description": "Confirmed root cause and full causal chain. For investigation only, use null exclusively when decisive evidence proves there is no defect or change to make; never use null for an inconclusive or inaccessible investigation."},
      evidence: {"type": "list", "of": {"type": "string"}, "min": 1, "description": "Decisive fresh runtime, code, or test observations from this stage. Include at least one item."},
      fix_description: {"type": "string", "optional": true, "description": "The applied change and why it addresses the root cause. Required when stage is fix or verification."},
      verification_result: {"type": "string", "optional": true, "description": "Stage-scoped evidence of the fix or of the final verification. Required when stage is fix or verification."},
    },
  },
  "qa-surface-map-handoff": {
    summary: "Brief description of the project under QA and what the surface map covers.",
    fields: {
      run_dir: {"type": "string", "description": "Timestamped QA run directory created for this pass, e.g. docs/qa/runs/qa-2026-05-25-150000. The verify step writes changelog.md and unclear-findings.md here."},
      surface_map_path: {"type": "path", "description": "Path to the human-readable surface map markdown written to disk, typically <run_dir>/surface-map.md."},
      source_files_inspected: {"type": "list", "min": 1, "of": {"type": "path"}, "description": "Repo-relative paths of the source files the inventory was derived from. Inventory must come from code, not docs."},
      surfaces: {"type": "list", "min": 1, "description": "Flat array of surface items. Each item has id, category (entry_point | command | screen | interaction | configuration | external_dependency | persistence | output_format | lifecycle_state | failure_mode), name, location (repo-relative file path with optional :line), description, expected_behavior. Optional: dependencies (other surface ids or external services), notes.", "of": {"type": "object", "fields": {"id": {"type": "string", "description": "Kebab-case stable id, unique in the map."}, "category": {"type": "enum", "values": ["entry_point", "command", "screen", "interaction", "configuration", "external_dependency", "persistence", "output_format", "lifecycle_state", "failure_mode"], "description": "The kind of surface."}, "name": {"type": "string", "description": "Short human label."}, "location": {"type": "string", "description": "Repo-relative file path with optional :line of the defining production code, never documentation."}, "description": {"type": "string", "description": "What this surface is, in one or two sentences."}, "expected_behavior": {"type": "string", "description": "The concrete user-visible result the verifier must exercise."}, "dependencies": {"type": "list", "optional": true, "of": {"type": "string"}, "description": "Other surface ids or external services."}, "notes": {"type": "string", "optional": true, "description": "Optional campaign-specific variants or constraints."}}}},
      open_questions: {"type": "list", "optional": true, "of": {"type": "string"}, "description": "Unresolved uncertainties about the surface that the verify step needs to resolve."},
    },
  },
  "qa-findings-handoff": {
    summary: "Brief rollup of what was covered, what was fixed, and what remains blocking.",
    commands: {"min": 1},
    fields: {
      changelog_path: {"type": "path", "description": "Path to changelog.md written under run_dir. Contains scenarios run, evidence, fixes, and the full ledger."},
      unclear_findings_path: {"type": "path", "description": "Path to unclear-findings.md written under run_dir. Contains every blocking-unfixable item with repro, evidence, attempted fixes, and next action."},
      ledger: {"type": "list", "min": 1, "description": "Array of one ledger row per surface item. Each row: { surface_id, status (verified | fixed-and-reverified | blocking-unfixable), verification_method (live-drive | artifact-check | external-probe | source-of-truth), evidence, notes? }. No row may be left out and no status outside the three allowed values. `verification_method` MUST be `live-drive` for entry_point | command | screen | interaction | output_format | lifecycle_state | failure_mode surfaces; those categories cannot be verified by reading source. `artifact-check` is for persistence-category surfaces verified by inspecting the persisted file. `external-probe` is for external_dependency surfaces verified via a sanitized live probe. `source-of-truth` is only valid for configuration-category surfaces whose only existence is a schema/registry entry.", "of": {"type": "object", "fields": {"surface_id": {"type": "string", "description": "The surface id from the surface map."}, "status": {"type": "enum", "values": ["verified", "fixed-and-reverified", "blocking-unfixable"], "description": "The final status of the row."}, "verification_method": {"type": "enum", "values": ["live-drive", "artifact-check", "external-probe", "source-of-truth"], "description": "How the row was verified."}, "evidence": {"type": "string", "description": "A product-emitted artifact path or a sanitized observation summary. Never a source file path for a runtime method."}, "notes": {"type": "string", "optional": true, "description": "Anything a reader of the row needs beyond the evidence."}}}},
      fixes: {"type": "list", "optional": true, "description": "Array of fixes applied during the pass: { surface_id, issue, fix_summary, files_changed[], tests_run[]? }. Omit when no fixes were applied.", "of": {"type": "object", "fields": {"surface_id": {"type": "string", "description": "The surface id the fix belongs to."}, "issue": {"type": "string", "description": "What was wrong."}, "fix_summary": {"type": "string", "description": "What changed and why."}, "files_changed": {"type": "list", "min": 1, "of": {"type": "string"}, "description": "Repo-relative paths the fix changed."}, "tests_run": {"type": "list", "optional": true, "of": {"type": "string"}, "description": "The test commands run after the fix."}}}},
      blocking_findings: {"type": "list", "optional": true, "description": "Array of blocking-unfixable findings: { surface_id, severity (critical | major | minor), repro, evidence, attempted_fixes, next_action }. Must match every ledger row whose status is blocking-unfixable.", "of": {"type": "object", "fields": {"surface_id": {"type": "string", "description": "The surface id of the blocked row."}, "severity": {"type": "enum", "values": ["critical", "major", "minor"], "description": "The severity of the finding."}, "repro": {"type": "string", "description": "Exact steps, including the isolated environment used."}, "evidence": {"type": "string", "description": "Paths to product-emitted artifacts or sanitized observations."}, "attempted_fixes": {"type": "string", "description": "The distinct approaches attempted."}, "next_action": {"type": "string", "description": "The single concrete next step."}}}},
    },
  },
  "qa-contest-handoff": {
    summary: "Brief rollup of what was contested and why, or confirmation that the prior pass is clean.",
    fields: {
      findings: {"type": "list", "description": "Array of contest findings. Each finding: { surface_id, kind (capture_mismatch | no_observable_change | duplicate_capture | source_evidence | thin_blocking | visual_anomaly | missed_bug | rationalization | coverage_gap), severity (critical | major | minor), description (what is wrong and why the prior verdict is inadequate), evidence (capture path, ledger row reference, or unclear-findings entry; NEVER a source file path), suggested_action (what the next test-fix-surface pass must do) }. Use [] when the prior pass is clean.", "of": {"type": "object", "fields": {"surface_id": {"type": "string", "description": "The id from the prior ledger, or a new id for a coverage_gap finding."}, "kind": {"type": "enum", "values": ["capture_mismatch", "no_observable_change", "duplicate_capture", "source_evidence", "thin_blocking", "visual_anomaly", "missed_bug", "rationalization", "coverage_gap"], "description": "The failure mode the finding shows."}, "severity": {"type": "enum", "values": ["critical", "major", "minor"], "description": "The severity of the finding."}, "description": {"type": "string", "description": "What is wrong with the prior pass's verdict, in 1-3 sentences. Include the specific contradiction or omission."}, "evidence": {"type": "string", "description": "Path to a product-emitted artifact, a ledger row reference, or 'observed during contest re-drive'. NEVER a src/... path."}, "suggested_action": {"type": "string", "description": "What the follow-up test-fix-surface pass must do for this finding."}}}},
    },
  },
  "reassessment-handoff": {
    summary: "Why the remaining phases stay as they are or change, and what evidence from the completed phase drove that decision.",
    fields: {
      changes: {"type": "list", "description": "Re-spec to REMAINING phases only. Empty when the remaining phases stay unchanged, which is the default; change them only with concrete evidence. Each change: { action (\"drop\" | \"replace\" | \"insert\"), phase_id (the remaining-phase id for drop/replace, or the remaining/just-completed anchor id for insert), phase (the new/replacement phase object, required for replace/insert) }. Completed phases are immutable.", "of": {"type": "variant", "tag": "action", "cases": {"drop": {"phase_id": {"type": "string", "description": "The id of a remaining phase for drop and replace, or of the remaining or just-completed phase after which insert adds the new phase."}}, "replace": {"phase_id": {"type": "string", "description": "The id of a remaining phase for drop and replace, or of the remaining or just-completed phase after which insert adds the new phase."}, "phase": {"type": "object", "fields": {"id": {"type": "string", "description": "The phase id."}}, "description": "The new or replacement phase, in the same shape as the phases of the plan."}}, "insert": {"phase_id": {"type": "string", "description": "The id of a remaining phase for drop and replace, or of the remaining or just-completed phase after which insert adds the new phase."}, "phase": {"type": "object", "fields": {"id": {"type": "string", "description": "The phase id."}}, "description": "The new or replacement phase, in the same shape as the phases of the plan."}}}}},
    },
  },
  "inspiration-improvement-batch": {
    summary: "One-paragraph account of the audit: what the source claimed, which capabilities were judged better, and what was dismissed and why.",
    fields: {
      provenance: {"type": "variant", "tag": "source_type", "description": "Object identifying the audited bookmark. Always { source_type, bookmark_id, source_url }; source_type \"article\" needs nothing more, source_type \"github\" also needs local_clone (a workspace-relative path below inspiration/raindrop/) and source_commit (the full 40-char lowercase hex commit of the clone). Validation resolves the clone and the commit from the worker working directory.", "cases": {"article": {"bookmark_id": {"type": "string", "description": "The numeric Raindrop bookmark id."}, "source_url": {"type": "string", "description": "The http(s) URL of the source, without embedded credentials."}}, "github": {"bookmark_id": {"type": "string", "description": "The numeric Raindrop bookmark id."}, "source_url": {"type": "string", "description": "The http(s) URL of the source, without embedded credentials."}, "local_clone": {"type": "string", "description": "The workspace-relative clone path below inspiration/raindrop/."}, "source_commit": {"type": "string", "description": "The full 40-character lowercase hex commit of the clone."}}}},
      plan_artifacts: {"type": "list", "description": "Array of { path, disposition, summary } for the research and plan artifacts this audit wrote. path is relative to the worker working directory and names a docs/research/*.md or docs/plans/*.md file that must exist; disposition is \"created\" or \"updated\". Exactly one docs/research/*.md research artifact is required; a plan belongs here only when the audit reached a proposal. The companion docs/plans/README.md roster edit is not an artifact entry.", "of": {"type": "object", "fields": {"path": {"type": "path", "description": "The workspace-relative path of the artifact."}, "disposition": {"type": "enum", "values": ["created", "updated"], "description": "Whether the audit created or updated the artifact."}, "summary": {"type": "string", "description": "What the artifact holds."}}}},
      definition_proposals: {"type": "list", "description": "Array of definition-improvement proposals. Empty when the source justifies no definition change.", "of": {"type": "object", "fields": {"title": {"type": "string", "description": "Concise title describing the definition gap and the proposed change. Slugified into the docs/improvements filename."}, "target_kind": {"type": "enum", "values": ["step_prompt", "workflow_template", "handoff_schema", "review_rubric", "validator", "test", "project_instruction", "adr"], "description": "What kind of definition the proposal targets: one of step_prompt, workflow_template, handoff_schema, review_rubric, validator, test, project_instruction, adr."}, "target_path": {"type": "path", "exists": false, "description": "Workspace-relative path of the definition the proposal is about (e.g. src/workflows/workflows/steps/fly.spec-create.md). Never mutated; the consumer writes a separate proposal doc."}, "authority": {"type": "enum", "values": ["project_local", "user_global", "shipped_default"], "description": "Which definition layer owns the target: project_local (this repo), user_global (~/.flywheel), or shipped_default (the bundled definitions). The consumer derives the risk tier from this; do not self-assess risk."}, "source_evidence": {"type": "list", "min": 1, "description": "Array of { kind, reference, summary }. kind is one of step_failure, handoff_validation_failure, retry_pattern, review_finding, qa_gap, user_correction, budget_exhaustion, verification_gap, trace_fact, external_source; reference names a durable artifact (fact position, session id, handoff field, file:line); summary is one sentence.", "of": {"type": "object", "fields": {"kind": {"type": "enum", "values": ["step_failure", "handoff_validation_failure", "retry_pattern", "review_finding", "qa_gap", "user_correction", "budget_exhaustion", "verification_gap", "trace_fact", "external_source"], "description": "The kind of evidence."}, "reference": {"type": "string", "description": "A durable artifact: a fact position, a session id, a handoff field, or file:line."}, "summary": {"type": "string", "description": "One sentence."}}}}, "finding": {"type": "string", "description": "What went wrong or what friction recurred, grounded in the cited evidence."}, "proposal": {"type": "string", "description": "The specific definition change proposed and why it prevents recurrence."}, "diff_preview": {"type": "string", "description": "A unified-diff sketch of the proposed change. Evidence only; the deterministic consumer never applies it."}, "acceptance_check": {"type": "string", "description": "How a reviewer verifies the change worked (a command, a scenario, an observable behavior)."}}}},
    },
  },
  "definition-improvement-proposal": {
    summary: "Brief summary of the proposal.",
    fields: {
      title: {"type": "string", "description": "Concise title describing the definition gap and the proposed change. Slugified into the docs/improvements filename."},
      target_kind: {"type": "enum", "values": ["step_prompt", "workflow_template", "handoff_schema", "review_rubric", "validator", "test", "project_instruction", "adr"], "description": "What kind of definition the proposal targets: one of step_prompt, workflow_template, handoff_schema, review_rubric, validator, test, project_instruction, adr."},
      target_path: {"type": "path", "exists": false, "description": "Workspace-relative path of the definition the proposal is about (e.g. src/workflows/workflows/steps/fly.spec-create.md). Never mutated; the consumer writes a separate proposal doc."},
      authority: {"type": "enum", "values": ["project_local", "user_global", "shipped_default"], "description": "Which definition layer owns the target: project_local (this repo), user_global (~/.flywheel), or shipped_default (the bundled definitions). The consumer derives the risk tier from this; do not self-assess risk."},
      source_evidence: {"type": "list", "min": 1, "description": "Array of { kind, reference, summary }. kind is one of step_failure, handoff_validation_failure, retry_pattern, review_finding, qa_gap, user_correction, budget_exhaustion, verification_gap, trace_fact, external_source; reference names a durable artifact (fact position, session id, handoff field, file:line); summary is one sentence.", "of": {"type": "object", "fields": {"kind": {"type": "enum", "values": ["step_failure", "handoff_validation_failure", "retry_pattern", "review_finding", "qa_gap", "user_correction", "budget_exhaustion", "verification_gap", "trace_fact", "external_source"], "description": "The kind of evidence."}, "reference": {"type": "string", "description": "A durable artifact: a fact position, a session id, a handoff field, or file:line."}, "summary": {"type": "string", "description": "One sentence."}}}},
      finding: {"type": "string", "description": "What went wrong or what friction recurred, grounded in the cited evidence."},
      proposal: {"type": "string", "description": "The specific definition change proposed and why it prevents recurrence."},
      diff_preview: {"type": "string", "description": "A unified-diff sketch of the proposed change. Evidence only; the deterministic consumer never applies it."},
      acceptance_check: {"type": "string", "description": "How a reviewer verifies the change worked (a command, a scenario, an observable behavior)."},
    },
  },
  "research-handoff": {
    summary: "Brief summary of research findings.",
    fields: {
      file_path: {"type": "path", "description": "Path to the research document written to disk (e.g. docs/research/2026-05-01-topic.md)."},
    },
  },
  "review-handoff": {
    summary: "Brief summary of the review.",
    fields: {
      findings: {"type": "list", "description": "Structured review findings. Use [] when the review found no actionable findings.", "of": {"type": "object", "fields": {"title": {"type": "string", "description": "Short title of the finding."}, "severity": {"type": "enum", "values": ["critical", "major", "minor"], "description": "critical and major block; minor is advisory."}, "file": {"type": "string", "description": "Repository-relative path."}, "description": {"type": "string", "description": "What is wrong and how to fix it."}}}},
      blocking_findings: {"type": "list", "description": "The findings whose severity is critical or major, copied from findings. Use [] when none blocks.", "of": {"type": "object", "fields": {"title": {"type": "string", "description": "Short title of the finding."}, "severity": {"type": "enum", "values": ["critical", "major", "minor"], "description": "critical and major block; minor is advisory."}, "file": {"type": "string", "description": "Repository-relative path."}, "description": {"type": "string", "description": "What is wrong and how to fix it."}}}},
      feedback: {"type": "string", "optional": true, "description": "Concrete feedback for the next iteration when the review surfaces issues that should drive a retry. Omit when no retry is warranted."},
    },
  },
} satisfies { readonly [handoffType: string]: OutputObject };

const CONTRACTS_BY_TYPE: ReadonlyMap<string, OutputObject> = new Map(Object.entries(RETIRED_HANDOFF_CONTRACTS));

/** The frozen grammar of one retired handoff type, or undefined for a name
 *  that was never a handoff type and for `spec-handoff`. */
export function retiredHandoffContract(handoffType: string): OutputObject | undefined {
  return CONTRACTS_BY_TYPE.get(handoffType);
}
