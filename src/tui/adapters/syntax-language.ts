import { infoStringToFiletype } from "@opentui/core"

export type ResolvedSyntaxLanguage =
  | { kind: "opentui"; openTui: string; highlightJs: string }
  | { kind: "highlight-js"; highlightJs: string }

interface LanguageLookup {
  [language: string]: string
}

const LANGUAGE_ALIASES: Readonly<LanguageLookup> = {
  tsx: "typescriptreact",
  jsx: "javascriptreact",
  shell: "bash",
  zsh: "bash",
  python3: "python",
  golang: "go",
  "c-sharp": "csharp",
  containerfile: "dockerfile",
  ps: "powershell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  proto: "protobuf",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  gradle: "groovy",
  tex: "latex",
  ml: "ocaml",
  mli: "ocaml",
  vue: "javascriptreact",
  svelte: "javascriptreact",
}

const HIGHLIGHT_JS_LANGUAGES: Readonly<LanguageLookup> = {
  typescriptreact: "typescript",
  javascriptreact: "javascript",
}

const OPENTUI_LANGUAGES = new Set([
  "javascript",
  "javascriptreact",
  "markdown",
  "typescript",
  "zig",
])

export function resolveSyntaxLanguage(filetype: string | undefined): ResolvedSyntaxLanguage | null {
  const token = filetype
    ?.trim()
    .split(/[,\t ]/, 1)[0]
    ?.toLowerCase()
  if (!token) return null

  const canonical = LANGUAGE_ALIASES[token] ?? infoStringToFiletype(token) ?? token
  const highlightJs = HIGHLIGHT_JS_LANGUAGES[canonical] ?? canonical
  return OPENTUI_LANGUAGES.has(canonical)
    ? { kind: "opentui", openTui: canonical, highlightJs }
    : { kind: "highlight-js", highlightJs }
}
