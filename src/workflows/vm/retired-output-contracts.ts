/** Output contracts that the lexicon change renamed, frozen as the last
 *  build before phases shipped them, each beside the contract that replaced
 *  it. The implementation plan named its units `phases` and now names them
 *  `milestones`. A run paused before the change recorded the frozen
 *  contract's schema hash, and a Resume proves that only the rename
 *  separates it from the current contract (refer to
 *  `adoptPhaseGrammarIdentity`). Remove after 2027-04-30. */
import { Result } from "effect";
import planContract from "../workflows/contracts/implementation-plan.json" with { type: "json" };
import { compileOutput } from "../output-contract/compile.js";
import { decodeOutputObject } from "../output-contract/grammar.js";

/** `contracts/implementation-plan.json` at commit 301e51b8b. */
const RETIRED_IMPLEMENTATION_PLAN = {
  "submit": "file",
  "summary": "Brief summary of the plan.",
  "fields": {
    "schema_version": {
      "type": "enum",
      "values": [
        1
      ],
      "description": "Plan schema version. Must be 1."
    },
    "context": {
      "type": "object",
      "description": "Plan context: key_files, patterns, constraints (constraints[0] is the verbatim user description), and optional project_docs (doc paths consulted during research, forwarded to reviewers).",
      "fields": {
        "key_files": {
          "type": "list",
          "optional": true,
          "of": {
            "type": "string"
          },
          "description": "Repo-relative paths with one-line reasons."
        },
        "patterns": {
          "type": "list",
          "optional": true,
          "of": {
            "type": "string"
          },
          "description": "Existing patterns to follow."
        },
        "constraints": {
          "type": "list",
          "min": 1,
          "of": {
            "type": "string"
          },
          "description": "Pitfalls and design rationale. constraints[0] is the verbatim user description."
        },
        "project_docs": {
          "type": "list",
          "optional": true,
          "of": {
            "type": "string"
          },
          "description": "Doc paths consulted during research, forwarded to reviewers."
        }
      }
    },
    "phases": {
      "type": "list",
      "min": 1,
      "unique": "id",
      "description": "Array of direct implementation phases. Each phase has id, goal, files, tasks, and verification. Never include discovery or decision phases.",
      "of": {
        "type": "object",
        "fields": {
          "id": {
            "type": "string",
            "description": "The phase id."
          },
          "goal": {
            "type": "string",
            "description": "What the phase delivers."
          },
          "files": {
            "type": "list",
            "of": {
              "type": "string"
            },
            "description": "Repo-relative paths the phase is expected to touch."
          },
          "tasks": {
            "type": "list",
            "unique": "id",
            "description": "The concrete changes of the phase.",
            "of": {
              "type": "object",
              "fields": {
                "id": {
                  "type": "string",
                  "description": "The task id."
                },
                "description": {
                  "type": "string",
                  "description": "The concrete change."
                },
                "files": {
                  "type": "list",
                  "of": {
                    "type": "string"
                  },
                  "description": "Repo-relative paths the task changes."
                },
                "test_scenarios": {
                  "type": "list",
                  "of": {
                    "type": "string"
                  },
                  "description": "Plain statements of the expected behavior."
                }
              }
            }
          },
          "verification": {
            "type": "string",
            "description": "A runnable command that proves this phase alone."
          },
          "qualitative_verification": {
            "type": "string",
            "optional": true,
            "nullable": true,
            "description": "The judgment that no command can prove, or null."
          }
        }
      }
    },
    "success_criteria": {
      "type": "list",
      "min": 1,
      "of": {
        "type": "string"
      },
      "description": "Measurable criteria for the implementation to be considered complete."
    },
    "implementation_contract": {
      "type": "object",
      "optional": true,
      "description": "A compact contract for the implementer: 1-4 directives, each { id, text, completion_check }. fly.spec-create originates it and spec-review preserves an existing contract. Downstream work steps echo every directive in contract_result.",
      "fields": {
        "directives": {
          "type": "list",
          "min": 1,
          "max": 4,
          "unique": "id",
          "description": "One concrete commitment for each directive.",
          "of": {
            "type": "object",
            "fields": {
              "id": {
                "type": "string",
                "description": "The directive id."
              },
              "text": {
                "type": "string",
                "description": "The commitment the diff either satisfies or does not."
              },
              "completion_check": {
                "type": "string",
                "description": "A file, test, command, or exact symbol the work handoff can cite."
              }
            }
          }
        }
      }
    }
  }
};

/** The schema hash of a contract. */
function schemaSha256(contract: unknown): string {
  const decoded = decodeOutputObject(contract);
  if (Result.isFailure(decoded)) throw new Error(`A frozen output contract does not decode: ${decoded.failure.join("; ")}`);
  return compileOutput(decoded.success).schemaSha256;
}

let pairs: ReadonlyMap<string, string> | undefined;

/** Each renamed contract's frozen schema hash, mapped to the schema hash of
 *  the contract that replaced it. */
export function retiredOutputContractPairs(): ReadonlyMap<string, string> {
  pairs ??= new Map([[schemaSha256(RETIRED_IMPLEMENTATION_PLAN), schemaSha256(planContract)]]);
  return pairs;
}
