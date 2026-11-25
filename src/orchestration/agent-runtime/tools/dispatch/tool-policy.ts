/** Execution-time tool whitelist. The advertised tool schema stays
 *  byte-identical for the provider prefix cache; a call outside the
 *  whitelist is denied at dispatch with the owner's message instead. */
export interface ExecutionWhitelist {
  tools: ReadonlySet<string>;
  deniedReason: (toolName: string) => string;
}
