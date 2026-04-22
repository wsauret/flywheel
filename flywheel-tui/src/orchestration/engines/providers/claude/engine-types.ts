export interface EngineCommand {
  command: string;
  args: string[];
  stdinPrompt: boolean;
  promptPrefix?: string;
}

export interface EngineCommandOptions {
  model?: string;
  resumeSessionId?: string;
  tools?: ReadonlyArray<string>;
  systemPrompt?: string;
  effort?: string;
  settings?: string;
}
