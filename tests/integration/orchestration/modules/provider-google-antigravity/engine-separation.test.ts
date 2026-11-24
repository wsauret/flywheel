/**
 * Separation of the Google Antigravity engines from the person's own Antigravity and Gemini files (plan M13). Two auth
 * profiles hold one login each; a tree on each login serves a tool round through the real provider client and the real
 * pinned `agy acp` against the fake Gemini host, beside an account home and a project that hold agy and Gemini files of
 * their own (sentinels). Every file under the account home, the project, and both profiles is read before and after:
 * only the two login directories change, the session files of the closed processes are gone, and a logout of one
 * login (agy's own logout, on a login whose sign-in the test stands in for) removes only that login, while the other
 * still serves.
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import { dirname, join, relative } from "node:path"
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../../../src/infra/process-supervisor.js"
import { antigravityAccounts, logoutAntigravityAccount, type AntigravityProfile } from "../../../../../src/orchestration/modules/provider-google-antigravity/login/login.js"
import { createLoginObservations } from "../../../../../src/orchestration/modules/provider-google-antigravity/login/login-status.js"
import { accountRecordPath, loginsDirectory } from "../../../../../src/orchestration/modules/provider-google-antigravity/names.js"
import type { ToolDef } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { engineCall, openClientRig, result, send, user } from "./_client.js"
import { expectNoEngineLeft, openEngineHarness, type HarnessLogin } from "./_engine.js"

const temporary = temporaryDirectories()
expectNoEngineLeft()

const ECHO: ToolDef = { name: "echo", description: "Echoes its text.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
const SYSTEM = { stable: "STABLE-TIER-MARKER", session: "", conversation: "" }

/** Every file under `dir` with its size and digest, and every directory, by relative path. */
function treeState(dir: string): ReadonlyMap<string, string> {
  const state = new Map<string, string>()
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const key = relative(dir, path).replaceAll("\\", "/")
      if (entry.isDirectory()) {
        state.set(key, "directory")
        visit(path)
      } else {
        state.set(key, `${String(statSync(path).size)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`)
      }
    }
  }
  visit(dir)
  return state
}

/** The paths whose state differs between `before` and `after`, also those that only one of them holds. */
function changed(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).toSorted()
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** agy and Gemini files that would change what an engine sends, or which agent, tools, and hooks it runs, if it read
 *  them: settings, memory text, an agent of Flywheel's own name, an MCP server, a hook, and a rule. */
function writeSentinels(dir: string, marker: string): void {
  for (const config of [join(dir, ".gemini"), join(dir, ".agents")]) {
    write(join(config, "settings.json"), JSON.stringify({ model: { name: `${marker}-model` } }))
    write(join(config, "antigravity-cli", "settings.json"), JSON.stringify({ useG1Credits: true, marker }))
    write(join(config, "config", "agents", "flywheel", "agent.md"), `---\nname: flywheel\nmainAgent: true\n---\n${marker} agent text\n`)
    write(join(config, "agents", "flywheel", "agent.md"), `---\nname: flywheel\nmainAgent: true\n---\n${marker} agent text\n`)
    write(join(config, "config", "mcp_config.json"), JSON.stringify({ mcpServers: { [marker]: { command: join(dir, "absent-server") } } }))
    write(join(config, "mcp_config.json"), JSON.stringify({ mcpServers: { [marker]: { command: join(dir, "absent-server") } } }))
    write(join(config, "config", "hooks.json"), JSON.stringify({ [marker]: { PreInvocation: [{ type: "command", command: "exit 3", timeout: 5 }] } }))
    write(join(config, "hooks.json"), JSON.stringify({ [marker]: { PreInvocation: [{ type: "command", command: "exit 3", timeout: 5 }] } }))
    write(join(config, "rules", "rule.md"), `${marker} rule text`)
  }
  write(join(dir, "GEMINI.md"), `${marker} memory text`)
  write(join(dir, "AGENTS.md"), `${marker} memory text`)
}

/** The ids of the engine sessions that have files in a login's home. */
function sessionFiles(loginDir: string): string[] {
  const data = join(loginDir, "home", ".gemini", "antigravity-cli")
  return ["conversations", "brain", "annotations"].flatMap((folder) => existsSync(join(data, folder)) ? readdirSync(join(data, folder)) : [])
}

describe("Google Antigravity engines and the person's own Antigravity and Gemini files", () => {
  test("two logins of two profiles serve beside the person's files and change only their own login directories; a logout ends one login and leaves the other", async () => {
    // The sentinels sit in the temporary directory, which can lie behind a link (/var on macOS).
    const root = realpathSync(temporary("ags-"))
    const home = join(root, "h")
    const projectRoot = join(root, "p")
    writeSentinels(home, "PERSON-HOME")
    writeSentinels(projectRoot, "PERSON-PROJECT")
    // The person's environment names the account home and their own Gemini settings; none of it may reach an engine.
    const person = {
      home,
      environment: {
        ...process.env, HOME: home, USERPROFILE: home, GEMINI_HOME: join(home, ".gemini"), XDG_CONFIG_HOME: join(home, ".config"),
        APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, ".gemini", "settings.json"),
      },
    }
    // Two auth profiles with one login each.
    const place = (authDir: string, id: string) => ({ authDir, id, loginDir: join(loginsDirectory(authDir), id) })
    const [a, b] = [place(join(root, "a"), "la"), place(join(root, "b"), "lb")] as const
    // The stand-in for agy's sign-in: the token-free account record that a completed login writes.
    for (const { loginDir, id } of [a, b]) {
      write(accountRecordPath(loginDir), `${JSON.stringify({ version: 1, accountId: id, identity: `${id}@example.com`, createdAt: "2026-11-22T00:00:00.000Z", refreshedAt: "2026-11-22T00:00:00.000Z" })}\n`)
    }
    const before = treeState(root)

    const harness = openEngineHarness(root, {}, person)
    const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() })
    const launcher = createLauncherScope(supervisor)
    const sessionIds = new Set<string>()
    let afterServing: ReadonlyMap<string, string> | undefined
    try {
      const logins = { a: await harness.login(relative(root, a.loginDir)), b: await harness.login(relative(root, b.loginDir)) }
      for (const login of Object.values(logins)) login.gate.onEvent((event) => { sessionIds.add(event.sessionId) })
      const serve = async (rig: ReturnType<typeof openClientRig>, login: HarnessLogin, name: string) => {
        const agent = await rig.agent({ login, tree: `tree-${name}`, session: `agent-${name}`, projectRoot })
        const history = [user(`HISTORY-MARKER ${name}`)]
        const called = await send(agent.client, { messages: history, tools: [ECHO], systemPrompt: SYSTEM })
        expect(called.calls.map((call) => call.input)).toEqual([{ text: name }])
        history.push(called.assistant, result(called.calls[0]!.id, `RESULT ${name}`))
        expect((await send(agent.client, { messages: history, tools: [ECHO], systemPrompt: SYSTEM })).stopReason).toBe("end_turn")
      }

      const rig = openClientRig(Object.values(logins))
      try {
        harness.fake.script(["a", "b"].flatMap((name) => [{ kind: "calls", when: `HISTORY-MARKER ${name}`, calls: [engineCall(name)] } as const, { kind: "text", when: `RESULT ${name}`, text: `done ${name}` } as const]))
        await Promise.all([serve(rig, logins.a, "a"), serve(rig, logins.b, "b")])
      } finally {
        await rig.close()
      }
      expect(harness.fake.requests.filter((request) => request.kind === "main")).toHaveLength(4)
      for (const marker of ["PERSON-HOME", "PERSON-PROJECT"]) expect(harness.fake.requests.filter((request) => request.body.includes(marker))).toEqual([])
      // The session files of every closed process are gone; the person's own `~/.gemini` holds none of these sessions.
      expect([sessionFiles(logins.a.loginDir), sessionFiles(logins.b.loginDir)]).toEqual([[], []])
      expect(sessionIds.size).toBeGreaterThan(0)
      const ownGemini = join(userInfo().homedir, ".gemini", "antigravity-cli")
      for (const id of sessionIds) for (const folder of ["conversations", "brain", "annotations"]) {
        expect(existsSync(join(ownGemini, folder)) ? readdirSync(join(ownGemini, folder)).filter((name) => name.startsWith(id)) : []).toEqual([])
      }
      afterServing = treeState(logins.b.loginDir)

      const profile = (authDir: string): AntigravityProfile => ({
        authDir,
        host: { account: { home, user: userInfo().username }, platform: process.platform, hostEnvironment: person.environment, testEnvironment: { GOOGLE_GEMINI_BASE_URL: harness.fake.url, GEMINI_API_KEY: "flywheel-fake-key" } },
        gateHook: (loginDir) => {
          const login = Object.values(logins).find((candidate) => candidate.loginDir === loginDir)
          if (login === undefined) throw new Error(`no login at ${loginDir}`)
          return login.gateHook
        },
        withLoginReleased: (_loginDir, _signal, work) => work(),
        observations: createLoginObservations(),
      })
      await logoutAntigravityAccount(profile(a.authDir), a.id, { launcher })
      expect([antigravityAccounts(a.authDir).map((account) => account.accountId), antigravityAccounts(b.authDir).map((account) => account.accountId)]).toEqual([[], [b.id]])
      expect(existsSync(logins.a.loginDir)).toBe(false)
      expect(treeState(logins.b.loginDir)).toEqual(afterServing)

      // The other login still serves.
      const again = openClientRig([logins.b])
      try {
        const agent = await again.agent({ login: logins.b, tree: "tree-b2", session: "agent-b2", projectRoot })
        expect((await send(agent.client, { messages: [user("still here")], tools: [ECHO], systemPrompt: SYSTEM })).stopReason).toBe("end_turn")
      } finally {
        await again.close()
      }
    } finally {
      await launcher.close()
      await supervisor.dispose()
      await harness.close()
    }

    const after = treeState(root)
    const loginDirs = [a, b].map(({ loginDir }) => relative(root, loginDir).replaceAll("\\", "/"))
    const outside = changed(before, after).filter((path) => !loginDirs.some((dir) => path === dir || path.startsWith(`${dir}/`)))
    expect(outside).toEqual([])
    expect(changed(before, after).some((path) => path.startsWith(`${loginDirs[1]!}/`))).toBe(true)
  }, 180_000)
})
