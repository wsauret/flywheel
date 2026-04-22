const DEFAULT_MAX_OUTPUT_BYTES = 50_000;

export function truncateToolOutput(output: string, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): string {
  if (output.length <= maxBytes) return output;
  const truncated = output.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf("\n");
  const clean = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
  return `${clean}\n\n... output truncated (exceeded ${maxBytes} bytes)`;
}
