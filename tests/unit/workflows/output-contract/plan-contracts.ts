/** Step md frontmatter copied byte for byte from the design record of the
 *  step-content cutover: the investigate and plan steps, each with its output
 *  contract. */

export const debugInvestigateFrontmatter = `name: Investigate
dependencies: [root-cause-analysis]
output:
  summary: Concise result of the investigation.
  fields:
    hypothesis:
      type: string
      nullable: true
      description: Confirmed root cause and full causal chain. Use null only when decisive evidence proves there is no defect or change to make. Never use null for an inconclusive or inaccessible investigation.
    evidence:
      type: list
      of: { type: string }
      min: 1
      description: Decisive fresh runtime, code, or test observations from this step.
`;

export const implementFrontmatter = `name: Implement
dependencies: [implementation]
agents: [implementer, reviewer-uat, advisor]
output:
  summary: What was done, the completed or replaced phase ids, the verification performed now and its result, and the current state. Name each warning and each file that needs a careful review here.
  fields:
    decisions:
      type: list
      of: { type: string }
      optional: true
      description: Material revisions of the plan or the low-level design, and why.
    contract_result:
      type: object
      optional: true
      description: Required when the plan carries implementation_contract. Account for every directive.
      fields:
        directives:
          type: list
          min: 1
          unique: id
          description: One entry for each plan directive.
          of:
            type: variant
            tag: status
            cases:
              satisfied:  { id: { type: string, description: The directive id. }, evidence: { type: string, description: A test name, file path, command, or symbol. } }
              deviated:   { id: { type: string, description: The directive id. }, evidence: { type: string, description: What was built instead. }, reason: { type: string, description: Why. }, risk: { type: enum, values: [low, medium, high], description: Risk of the deviation. } }
              superseded: { id: { type: string, description: The directive id. }, instruction: { type: string, description: The quoted instruction that replaced the directive. }, source: { type: enum, values: [person, parent], description: Who gave it. } }
`;
