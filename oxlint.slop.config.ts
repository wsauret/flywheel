import { defineConfig } from "oxlint";

import { effectJevPluginName, effectSourceJevRules } from "./scripts/anti-slop-llm/effect-rules.ts";
import { martinFowlerJevPluginName, martinFowlerJevRules } from "./scripts/anti-slop-llm/fowler-rules.ts";

// The LLM-judged anti-slop rules, which `bun run lint:slop`, `lint:slop:full`, and their callers
// use. Every uncached answer is a paid decision-model request, so this config stays out of
// `bun run lint` and every shared gate. Only the judged rules run: oxlint's default rules belong
// to oxlint.config.ts.
export default defineConfig({
  categories: { correctness: "off" },
  jsPlugins: [
    { name: effectJevPluginName, specifier: "./scripts/anti-slop-llm/effect-plugin.ts" },
    { name: martinFowlerJevPluginName, specifier: "./scripts/anti-slop-llm/fowler-plugin.ts" },
  ],
  rules: {
    ...Object.fromEntries(effectSourceJevRules.map((rule) => [`${effectJevPluginName}/${rule.id}`, "error"])),
    ...Object.fromEntries(martinFowlerJevRules.map((rule) => [`${martinFowlerJevPluginName}/${rule.id}`, "warn"])),
  },
});
