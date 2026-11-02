When the agent asks me a question and I interrupt before answering, every later message fails because Anthropic rejects an empty error result. Restarting does not repair the session. Fix both new interruptions and sessions that already contain these results.

The tool dispatcher must treat a suspended call as unfinished, not as a completed error. It must neither checkpoint nor publish a result for that call; the resume path owns its later answer. Keep ordinary completed results available and checkpointed immediately, even while another tool in the same batch is still running.

Use the shared conversation repair step before provider conversion to repair existing blank error results, not just interrupted questions. Treat whitespace-only text as blank, but leave results with images alone. Supply a short explanation that preserves the failure status and the connection to the original tool call. Explain the interruption when known; otherwise explain that the tool returned no content. Preserve existing meaningful error text, successful results, and later user messages.

Work out the implementation details and run the relevant tests. Verify that an interrupted question does not publish a premature result, and that reopening an affected session permits the next request.
