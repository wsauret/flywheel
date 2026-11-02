/** Static identity and presentation of a built-in slash command. */
export interface CommandSpec {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly aliases?: readonly string[]
  readonly keybinding?: string
  /** Excluded from palette listings; still dispatchable by token. */
  readonly hidden?: boolean
}

/** Runs one built-in command with the shell context constructed after modal
 *  openers. It answers false when the command refused the input after it told
 *  the person why, so the prompt gets the typed command back. */
type CommandExecute<Context> = (context: Context, arg: string | undefined) => boolean | Promise<boolean>

/** One immutable built-in command definition owns presentation and execution. */
export interface BuiltInCommandDefinition<Context = unknown> {
  readonly spec: CommandSpec
  readonly execute: CommandExecute<Context>
}
