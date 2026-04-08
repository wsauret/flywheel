import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/cli/index.ts"],
  outdir: "dist",
  target: "bun",
  plugins: [solidPlugin],
  conditions: ["browser"],
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log(`Build complete: ${result.outputs.length} file(s)`)
