import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { isExecutable, resolveInstalledBinary } from "../../scripts/uat/installed-binary.js"

const PROJECT_ROOT = resolve(import.meta.dir, "../..")
const SCRATCH_ROOT = process.argv[2] ?? join(PROJECT_ROOT, ".flywheel", "sessions", "4381a697805d", "scratch", `provider-fallback-${process.pid}`)
const PROXY_ADDON = join(import.meta.dir, "provider-fallback-proxy.py")
const MITMDUMP = process.env.MITMDUMP ?? "/opt/homebrew/bin/mitmdump"
const PROFILE = "fallback-fixture"
const SYNTHETIC_OPENAI_KEY = "fixture-openai-key-not-valid"
const SYNTHETIC_OPENROUTER_KEY = "fixture-openrouter-key-not-valid"

const SCENARIOS = ["quota", "unknown", "partial-tool"] as const
type Scenario = (typeof SCENARIOS)[number]
type Evidence = { kind: string; scenario: Scenario; provider?: string; model?: string; has_tool_result?: boolean; mentions_fixture_result?: boolean }

/** One line the proxy addon appends to its evidence file. Throws on a line
 *  that names no kind or no known scenario. */
function parseEvidence(line: string): Evidence {
  const value: unknown = JSON.parse(line)
  if (typeof value !== "object" || value === null) throw new Error(`proxy evidence is not an object: ${line}`)
  const fields: ReadonlyMap<string, unknown> = new Map(Object.entries(value))
  const [kind, provider, model, has_tool_result, mentions_fixture_result] = ["kind", "provider", "model", "has_tool_result", "mentions_fixture_result"].map((name) => fields.get(name))
  const known = SCENARIOS.find((name) => name === fields.get("scenario"))
  if (typeof kind !== "string" || known === undefined) throw new Error(`proxy evidence names no kind or known scenario: ${line}`)
  return {
    kind,
    scenario: known,
    ...(typeof provider === "string" ? { provider } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof has_tool_result === "boolean" ? { has_tool_result } : {}),
    ...(typeof mentions_fixture_result === "boolean" ? { mentions_fixture_result } : {}),
  }
}

async function command(command: string[], options: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean } = {}): Promise<string> {
  const processHandle = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  if (exitCode !== 0 && !options.allowFailure) throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr}`)
  return stdout
}

async function waitUntil(check: () => Promise<boolean>, description: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${description}`)
}

function scenarioPrompt(scenario: Scenario): string {
  if (scenario === "partial-tool") return "Read fixture.txt exactly once, then answer with the file contents. Do not use any other tool."
  return "Return the short success response."
}

async function seedScenario(home: string, project: string): Promise<void> {
  const userDataRoot = join(home, ".flywheel")
  const profileDir = join(userDataRoot, "auth", "profiles", PROFILE)
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  await mkdir(join(project, ".flywheel"), { recursive: true })
  await writeFile(join(profileDir, "profile.json"), `${JSON.stringify({ id: PROFILE, displayName: "Provider Fallback Fixture" }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(profileDir, "auth.json"), `${JSON.stringify({
    openai_api: { type: "api_key", key: SYNTHETIC_OPENAI_KEY, lineageId: "10000000-0000-4000-8000-000000000001" },
    openrouter: { type: "api_key", key: SYNTHETIC_OPENROUTER_KEY, lineageId: "20000000-0000-4000-8000-000000000002" },
  }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(profileDir, "model-preferences.json"), `${JSON.stringify({ version: 2, accounts: [
    { account: { kind: "singleton", providerId: "openai_api" }, enabled: ["gpt-5.4"] },
    { account: { kind: "singleton", providerId: "openrouter" }, enabled: ["gpt-5.4"] },
  ] }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(userDataRoot, "flywheel.toml"), "[notifications]\ndesktop = false\n")
  await writeFile(join(project, "fixture.txt"), "fixture-read-result\n")
}

async function pane(session: string): Promise<string> {
  return command(["tmux", "capture-pane", "-p", "-S", "-", "-t", session], { allowFailure: true })
}

async function sendText(session: string, text: string): Promise<void> {
  await command(["tmux", "send-keys", "-t", session, "-l", text])
  await Bun.sleep(500)
  await command(["tmux", "send-keys", "-t", session, "Enter"])
}

async function runScenario(scenario: Scenario, binary: string, proxyUrl: string, caFile: string, controlFile: string, artifactRoot: string): Promise<void> {
  const root = join(SCRATCH_ROOT, scenario)
  const home = join(root, "home")
  const project = join(root, "project")
  const stderrFile = join(artifactRoot, `${scenario}-stderr.log`)
  const paneFile = join(artifactRoot, `${scenario}-pane.log`)
  const eventsFile = join(artifactRoot, `${scenario}-events.jsonl`)
  const session = `flywheel-provider-fallback-${process.pid}-${scenario}`
  await mkdir(project, { recursive: true })
  await seedScenario(home, project)
  await writeFile(controlFile, JSON.stringify({ scenario }))
  const environment = [
    `FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS=${process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS ?? "1"}`,
    `HOME=${home}`,
    `FLYWHEEL_PROJECT_ROOT=${project}`,
    `FLYWHEEL_AUTH_PROFILE=${PROFILE}`,
    "FLYWHEEL_CHAT_MODEL=gpt-5.4",
    `HTTPS_PROXY=${proxyUrl}`,
    `https_proxy=${proxyUrl}`,
    `NODE_EXTRA_CA_CERTS=${caFile}`,
    `SSL_CERT_FILE=${caFile}`,
    `FLYWHEEL_BINARY=${binary}`,
    `FLYWHEEL_STDERR=${stderrFile}`,
  ]
  await command(["tmux", "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "env", ...environment, "sh", "-c", "exec \"$FLYWHEEL_BINARY\" 2>\"$FLYWHEEL_STDERR\""], { cwd: project })
  try {
    await waitUntil(async () => (await pane(session)).includes("for fresh chat"), `${scenario} TUI readiness`)
    await sendText(session, scenarioPrompt(scenario))
    const expected = scenario === "partial-tool" ? "FINAL-AFTER-RECORDED-READ" : "FALLBACK-SUCCESS"
    await waitUntil(async () => (await pane(session)).includes(expected), `${scenario} fallback answer`)
    const captured = await pane(session)
    await writeFile(paneFile, captured)
    if (scenario === "partial-tool" && !captured.includes("PARTIAL-FALLBACK-TEXT")) throw new Error("partial text was not retained in the pane")
    for (const forbidden of ["out of credits", "quota exceeded", "send a message to retry", "reconnecting", "fixture unknown provider failure", "failed preview"]) {
      if (captured.toLowerCase().includes(forbidden)) throw new Error(`${scenario} pane exposed intermediate failure text: ${forbidden}`)
    }
    const events = await command([binary, "events", "search", "--json", "--project-root", project, "--type", "model.requested", "--type", "model.response_received", "--type", "tool.result.recorded", "--limit", "1000"], { cwd: project, env: Object.fromEntries(environment.map((entry): [string, string] => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)] })) })
    await writeFile(eventsFile, events)
    if (!events.includes("model.requested") || !events.includes("model.response_received")) throw new Error(`${scenario} durable request/response evidence is incomplete`)
    if (scenario === "partial-tool" && events.split('"type":"tool.result.recorded"').length - 1 !== 1) throw new Error("harmless read did not record exactly one tool result")
  } catch (error) {
    await writeFile(paneFile, await pane(session))
    const stderr = existsSync(stderrFile) ? await readFile(stderrFile, "utf8") : ""
    throw new Error(`${String(error)}\nstderr: ${stderr}`)
  } finally {
    await command(["tmux", "kill-session", "-t", session], { allowFailure: true })
    await rm(home, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const artifactRoot = join(SCRATCH_ROOT, "artifacts")
  const proxyConfig = join(SCRATCH_ROOT, "mitm-conf")
  const controlFile = join(SCRATCH_ROOT, "scenario.json")
  const evidenceFile = join(artifactRoot, "proxy-order.jsonl")
  const proxyStderr = join(artifactRoot, "proxy-stderr.log")
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(proxyConfig, { recursive: true })
  await writeFile(controlFile, JSON.stringify({ scenario: "quota" }))
  await writeFile(evidenceFile, "")
  if (!await isExecutable(MITMDUMP)) throw new Error(`mitmdump was not found at ${MITMDUMP}`)
  const binary = await resolveInstalledBinary(PROJECT_ROOT)
  const port = Number((await command(["python3", "-c", "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"])) .trim())
  const proxy = Bun.spawn([MITMDUMP, "--quiet", "--listen-host", "127.0.0.1", "--listen-port", String(port), "--set", `confdir=${proxyConfig}`, "-s", PROXY_ADDON], {
    env: { ...process.env, FLYWHEEL_FALLBACK_CONTROL: controlFile, FLYWHEEL_FALLBACK_EVIDENCE: evidenceFile },
    stdout: "ignore",
    stderr: Bun.file(proxyStderr),
    windowsHide: true,
  })
  const caFile = join(proxyConfig, "mitmproxy-ca-cert.pem")
  const proxyUrl = `http://127.0.0.1:${port}`
  try {
    await waitUntil(async () => {
      if (!existsSync(caFile)) return false
      const result = Bun.spawn(["curl", "--silent", "--fail", "--proxy", proxyUrl, "--cacert", caFile, "https://api.openai.com/v1/models"], { stdout: "ignore", stderr: "ignore", windowsHide: true })
      return await result.exited === 0
    }, "proxy CA and readiness")
    for (const scenario of SCENARIOS) await runScenario(scenario, binary, proxyUrl, caFile, controlFile, artifactRoot)
    const evidence = (await readFile(evidenceFile, "utf8")).trim().split("\n").filter(Boolean).map(parseEvidence)
    for (const scenario of SCENARIOS) {
      const attempts = evidence.filter((entry) => entry.kind === "attempt" && entry.scenario === scenario).slice(0, 2)
      if (attempts.map(({ provider }) => provider).join(",") !== "openai_api,openrouter") throw new Error(`${scenario} provider order was not OpenAI then OpenRouter`)
      if (attempts.some(({ model }) => model !== "gpt-5.4" && model !== "openai/gpt-5.4")) throw new Error(`${scenario} used an unexpected model`)
      if (scenario === "partial-tool" && (!attempts[1]?.has_tool_result || !attempts[1]?.mentions_fixture_result)) throw new Error("replacement request did not include the canonical recorded tool result")
    }
    if (evidence.some(({ kind }) => kind === "blocked-outbound")) throw new Error("fixture blocked unexpected remote traffic")
    const secretFree = await readFile(evidenceFile, "utf8")
    if (secretFree.includes(SYNTHETIC_OPENAI_KEY) || secretFree.includes(SYNTHETIC_OPENROUTER_KEY)) throw new Error("proxy evidence contains credentials")
    console.log(`PASS provider fallback acceptance fixtures\nArtifacts: ${artifactRoot}`)
  } finally {
    proxy.kill()
    await proxy.exited
  }
}

await main()
