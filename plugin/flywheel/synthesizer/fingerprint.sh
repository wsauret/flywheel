#!/usr/bin/env bash
# fingerprint.sh — apply synthesizer policy to pre-grouped reviewer findings.
#
# This is a BLACK-BOX TOOL. Do not read this source to learn the contract.
# Run `fingerprint.sh --help` instead.
#
# CONTRACT
#   stdin:  JSON array of groups. Each group is:
#             { "reviewers": ["reviewer-x", ...], "finding": <finding-object> }
#           The finding object conforms to flywheel/schemas/findings.schema.json
#           (one entry from a reviewer's findings[] array).
#
#   stdout: JSON array. Each element is a finalized finding annotated with:
#             - fingerprint        stable identifier for cross-session grouping
#             - match_count        number of reviewers that reported this group
#             - reviewers_matched  unique list of reviewers
#             - finding.severity   promoted one level when match_count >= 2
#                                  (P3 → P2, P2 → P1, P1 unchanged)
#
#   flags:  --help    print this contract
#
# EXAMPLE
#   echo '[
#     {"reviewers":["reviewer-architecture","reviewer-code-quality"],
#      "finding":{"title":"conftest.py missing","severity":"P2",
#                 "scope":{"kind":"plan","phase_id":"phase-1"},
#                 "what_wrong":"...","suggested_fix":"...","evidence":"..."}}
#   ]' | fingerprint.sh
#
# SEMANTIC DEDUP IS THE CALLER'S JOB
#   The caller (plan-review or work-review synthesizer) decides which findings
#   are the same issue — reviewers may phrase a shared concern differently,
#   and recognizing the equivalence requires judgment the script does not have.
#   Once the caller has grouped findings, this script applies policy
#   (severity promotion + provenance) deterministically.

set -u

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,33p' "$0" | sed -E 's/^#( |$)//'
  exit 0
fi

jq '
  def slug:
    ascii_downcase
    | gsub("[^a-z0-9]+"; "-")
    | sub("^-"; "")
    | sub("-$"; "")
    | .[0:60];

  def promote(sev; count):
    if count >= 2 then
      (if sev == "P3" then "P2"
       elif sev == "P2" then "P1"
       else sev end)
    else sev end;

  def fingerprint:
    .finding as $f
    | ($f.title | slug) as $t
    | if $f.scope.kind == "code" then
        "code:\($f.scope.file):\($f.scope.line // "*"):\($t)"
      else
        "plan:\($f.scope.phase_id // "*"):\($f.scope.task_id // "*"):\($f.scope.bc_id // "*"):\($t)"
      end;

  map(
    . as $group
    | ($group.reviewers | unique) as $rs
    | ($rs | length) as $n
    | {
        fingerprint: fingerprint,
        match_count: $n,
        reviewers_matched: $rs,
        finding: ($group.finding | .severity = promote(.severity; $n))
      }
  )
'
