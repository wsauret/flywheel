import * as path from "node:path";

const SPECIAL_NAMES = {
  containerfile: "dockerfile",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

function isSpecialName(name: string): name is keyof typeof SPECIAL_NAMES {
  return name in SPECIAL_NAMES;
}

const EXTENSION_MAP = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", rb: "ruby",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  md: "markdown", css: "css", scss: "scss", html: "html",
  sql: "sql", sh: "bash", bash: "bash", zsh: "zsh",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  java: "java", kt: "kotlin", swift: "swift",
  lua: "lua", vim: "vim", xml: "xml", graphql: "graphql",
  dockerfile: "dockerfile", containerfile: "dockerfile",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  proto: "protobuf", nix: "nix", dart: "dart",
  ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang",
  scala: "scala", clj: "clojure", cljs: "clojure", cljc: "clojure",
  gradle: "groovy", ml: "ocaml", mli: "ocaml", tex: "latex",
  vue: "vue", svelte: "svelte",
};

function isKnownExtension(extension: string): extension is keyof typeof EXTENSION_MAP {
  return extension in EXTENSION_MAP;
}

export function getFiletype(filePath: string): string | undefined {
  if (!filePath) return undefined;

  const baseName = path.basename(filePath).toLowerCase();
  if (isSpecialName(baseName)) return SPECIAL_NAMES[baseName];

  const ext = baseName.split(".").pop()?.toLowerCase();
  if (!ext || ext === baseName) return undefined;

  return isKnownExtension(ext) ? EXTENSION_MAP[ext] : ext;
}
