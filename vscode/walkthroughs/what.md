## What Flywheel is

A coding agent that edits your files and, unusually, one that can prove what
it did. Every model call, tool run, and agent of a workflow is recorded as typed
evidence you can search and replay. Agents propose; deterministic code owns
durable state.

That principle is what makes the rest possible:

- **Durable workflows.** A workflow lists phases of agents that run in order,
  with verification between phases, retries with feedback, and pause and resume. Close
  the editor mid-run and the workflow resumes from its recorded state: it does
  not start over and it does not lose the thread.

- **Your subscription, not another bill.** Sign in with what you already pay
  for: ChatGPT, GitHub Copilot, SuperGrok, or OpenCode Go. Sign in to several
  accounts of the same subscription and turns rotate automatically when one hits
  its cap, falling back to your API keys. Which provider served each turn is a
  recorded fact rather than a guess.

- **Everything is inspectable.** Sessions are event-sourced into a local SQLite
  store. Nothing the agent claims is something you have to take on faith, and
  every file it touched shows up under Changes with a real diff you can revert.

- **It learns, with consent.** Skills and memory accumulate from real session
  outcomes, are stored as files you can read, and trace back to the sessions
  that produced them.

- **As minimal as you want.** Workflows, skills, subagents, learning, and
  background commands are each one toggle. Turn a capability off and it
  disappears entirely, tools, prompts, and commands with it. A plain, fast chat agent
  is a supported configuration.
