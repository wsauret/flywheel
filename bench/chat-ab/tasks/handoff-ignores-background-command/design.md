An agent can hand off a workflow step while its own background command still runs. The step then ends before the agent receives the result. Fix this so the agent cannot report work it has not seen.

Keep the decision with the existing owner of background work. Its handoff gate must cover all active work it owns, not just subagents. When a command finishes, keep its result pending until the existing delivery path confirms that the result has reached the agent. Command completion alone must not release the gate.

The refusal must distinguish running work from results awaiting delivery and identify the blocking work by its description. Tell the agent to end its turn, wait for running work or stop it, and incorporate delivered results before retrying handoff. Preserve the existing subagent gate and ordinary chat behavior. Run the relevant tests to verify both blocked states and successful handoff after result delivery.
