## Design variant

- The shared tool-argument reader owns the refusal, rather than a provider-specific check. Tool calls can arrive before the output-limit report.
- Incomplete argument documents must not be completed by inventing an ending. They are distinct from other invalid input, including cuts inside strings, between arguments, or on streams without a final stop reason.
- The existing dispatch refusal path returns an argument error without executing the tool, even with empty input. The error tells the model it can send the whole call again.
- Complete arguments retain control-character and bad-escape repair and surrounding-format removal. Complete calls still execute once with their full content.
- The adapter used by OpenRouter classifies an output-limit finish as output overflow, not normal turn completion. The existing agent loop owns continuation.
