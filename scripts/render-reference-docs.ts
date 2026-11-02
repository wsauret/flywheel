import { commandSyntax, rootHelp } from "../src/cli/root-help.js";
import { builtInCommandDeclarations, builtInCommandDescriptor } from "../src/orchestration/app-service/kernel-commands.js";
import { composeFirstPartyModules, SHIPPED_MODULES, type FirstPartyModule } from "../src/orchestration/modules.js";
import { buildCommandDefinitions } from "../src/tui/commands/command-definitions.js";
import type { CommandSpec } from "../src/tui/commands/command-types.js";
import { HELP_SHORTCUT_SECTIONS, helpShortcuts } from "../src/tui/components/modal-help-shortcuts.js";
import { createKeymap, DEFAULT_BINDINGS } from "../src/tui/keymap/keymap.js";
import { compareCodePoints } from "./render-config-docs.js";

// Each page renders from the code that defines what it lists, with the
// shipped catalog only: the development module never reaches a release, so
// its commands never reach a page.

const code = (text: string): string => `\`${text}\``;

/** Plain text in a table cell. Markdown reads `<` as HTML outside a code
 *  span, so a placeholder such as `<goal>` becomes a code span, which reads
 *  well both rendered and in the raw file that Flywheel installs. Any other
 *  `<`, `>`, or `&` is escaped. */
const plain = (text: string): string =>
  text.split(/(<[^<>\s]+>)/).map((part, index) => index % 2 === 1 ? code(part) : part.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")).join("");

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

function page(title: string, source: string, sections: readonly string[]): string {
  return [`# ${title}`, `This file is generated from ${source}. Run \`bun run docs:generate\` to update it.`, ...sections].join("\n\n") + "\n";
}

/** A description cell; every listed entry must have one. */
function described(entry: string, description: string): string {
  if (description.trim() === "") throw new Error(`Missing description for ${entry}`);
  return plain(description);
}

/** Every public `flywheel` command, with the root usage, options, and examples. */
export async function renderCliReference(modules: readonly FirstPartyModule[] = SHIPPED_MODULES): Promise<string> {
  const { synopsis, summary, kernel, contributed, options, examples } = await rootHelp(modules);
  const subcommands = [...kernel, ...contributed].map(({ noun, verbs }) => [
    `### ${code(`flywheel ${noun}`)}`,
    table(["Command", "Description"], verbs.map((verb) => {
      const syntax = `flywheel ${commandSyntax(noun, verb)}`;
      return [code(syntax), described(syntax, verb.description)];
    })),
  ].join("\n\n"));
  const headlessForms = options.flatMap((option) => option.forms ?? []);
  return page("Flywheel command line reference", "the command definitions", [
    "## Usage",
    ["```text", ...synopsis, ...headlessForms.map(({ syntax }) => syntax), "```"].join("\n"),
    summary.join(" "),
    "## Options",
    table(["Option", "Description"], options.map(({ flags, description, forms = [] }) => [
      code(flags),
      [described(flags, description), forms.map(({ syntax, note }) => note === undefined ? code(syntax) : `${code(syntax)} (${plain(note)})`).join(" or ")].filter((text) => text !== "").join(" "),
    ])),
    "## Examples",
    ["```text", ...examples, "```"].join("\n"),
    "## Subcommands",
    `Run ${code("flywheel <subcommand> --help")} for the details of one subcommand.`,
    ...subcommands,
  ]);
}

/** Every built-in slash command the shipped catalog and the terminal publish. */
export function renderCommandReference(modules: readonly FirstPartyModule[] = SHIPPED_MODULES): string {
  const { keymap } = createKeymap();
  const builtInCommands = builtInCommandDeclarations(composeFirstPartyModules(modules)).map(builtInCommandDescriptor);
  const specs: readonly CommandSpec[] = buildCommandDefinitions(keymap.chordFor, builtInCommands)
    .map(({ spec }) => spec)
    .filter((spec) => spec.hidden !== true)
    .toSorted((left, right) => compareCodePoints(left.id, right.id));
  return page("Flywheel slash commands", "the command definitions", [
    `Type a command at the start of the prompt, or choose it in the command palette (${code(keymap.chordFor("help"))}). Installed skills add commands of their own, which this page does not list.`,
    table(["Command", "Aliases", "Key", "Description"], specs.map((spec) => [
      code(`/${spec.id}`),
      (spec.aliases ?? []).map((alias) => code(`/${alias}`)).join(", "),
      spec.keybinding === undefined ? "" : code(spec.keybinding),
      described(`/${spec.id}`, spec.description),
    ])),
  ]);
}

/** The default keys of the terminal interface, grouped as the help modal groups them. */
export function renderKeyReference(): string {
  const { keymap } = createKeymap();
  const shortcuts = helpShortcuts(keymap.chordFor);
  return page("Flywheel key reference", "the key bindings", [
    `These are the default keys of the terminal interface. The ${code("/shortcuts")} command shows the same list with your changes applied.`,
    ...HELP_SHORTCUT_SECTIONS.flatMap((section) => [
      `## ${section}`,
      table(["Keys", "Action"], shortcuts.filter((shortcut) => shortcut[2] === section).map(([keys, label]) => [code(keys), described(keys, label)])),
    ]),
    "## Changing a key",
    `Set a new chord for an app navigation key in the ${code("[keybindings]")} table of ${code("~/.flywheel/flywheel.toml")}, keyed by its command id, for example ${code(`"tab.close" = "ctrl+q"`)}. A chord is modifiers (${code("ctrl")}, ${code("meta")}, ${code("shift")}) and one key, joined by ${code("+")}. The prompt, text editing, and selection keys cannot be changed.`,
    table(["Command id", "Default", "Action"], DEFAULT_BINDINGS.map(({ commandId, chord, label }) => [code(commandId), code(chord), label])),
  ]);
}
