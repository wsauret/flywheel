import { beforeEach, describe, expect, it, mock } from "bun:test"
import { FREE_PLAN_REPLACE_QUESTION } from "../../../src/infra/llm/free-plan-accounts.js"
import { keptFreePlanMessage } from "../../../src/protocol/client/auth-login.js"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redacted } from "effect"
import { credentialProviderDisplayName, type ProviderAuthStatus } from "../../../src/orchestration/auth/auth-actions.js"
import { runAuth, type AuthCommandDependencies, type AuthOperations } from "../../../src/cli/auth.js"
import { PromptCancelled } from "../../../src/cli/readline-prompt.js"
import { testDirectories } from "../../helpers/directories.js"
import { refusingLauncher } from "../../helpers/launcher-fake.js"
import { authDir } from "../../../src/infra/paths.js"
import type { AuthContext } from "../../../src/infra/auth/auth-context.js"
import { installCustomProviders } from "../../../src/infra/llm/custom-provider-registry.js"
import { composeRealmModuleSnapshot } from "../../../src/orchestration/modules.js"
import { authProviders } from "../../helpers/auth-context.js"

const AUTH_CONTEXT: AuthContext = {
  providers: authProviders(),
  credentialLineages: {}, droppedCredentials: [],
}

type OAuthFlow = NonNullable<ReturnType<AuthOperations["providerLoginFlow"]>>
type BrowserLogin = Extract<OAuthFlow, { flow: "browser" }>["login"]
type DeviceCodeLogin = Extract<OAuthFlow, { flow: "device-code" }>["login"]
const mockLoginWithApiKey = mock<AuthOperations["loginWithApiKey"]>(async () => AUTH_CONTEXT)
const mockLoginWithChatGPT = mock<BrowserLogin>(async (options) => {
  options.onAuthorizeUrl?.({ url: "https://auth.openai.com/authorize?state=test" })
  return AUTH_CONTEXT
})
const mockLoginWithCopilot = mock<DeviceCodeLogin>(async (options) => {
  options.onUserCode?.({ userCode: "ABCD-1234", url: "https://github.com/login/device" })
  return AUTH_CONTEXT
})
const mockLoginWithXai = mock<DeviceCodeLogin>(async (options) => {
  options.onUserCode?.({ userCode: "WXYZ-5678", url: "https://auth.x.ai/activate?code=WXYZ-5678" })
  return AUTH_CONTEXT
})
/** The flows the shipped definitions declare, answered from the mocks above. */
const mockProviderLoginFlow = mock<AuthOperations["providerLoginFlow"]>((providerId) => {
  const reconnect = async () => true
  if (providerId === "chatgpt") return { flow: "browser", login: mockLoginWithChatGPT, reconnect }
  if (providerId === "github_copilot") return { flow: "device-code", login: mockLoginWithCopilot, reconnect }
  if (providerId === "supergrok") return { flow: "device-code", login: mockLoginWithXai, reconnect }
  return undefined
})
const mockLogoutProvider = mock<AuthOperations["logoutProvider"]>(async () => AUTH_CONTEXT)
/** A status row of a provider that is not an external login, which reports no accounts. */
const status = (providerId: string, source: ProviderAuthStatus["source"]): ProviderAuthStatus => ({ providerId, source, accounts: [] })
const mockGetAuthStatus = mock<AuthOperations["getAuthStatus"]>(() => [
  status("anthropic_api", "unconfigured"),
  status("openai_api", "unconfigured"),
  status("google_api", "unconfigured"),
  status("openrouter", "unconfigured"),
  status("chatgpt", "unconfigured"),
  status("github_copilot", "unconfigured"),
])
const mockGetAuthStatusWithDiagnostics = mock<AuthOperations["getAuthStatusWithDiagnostics"]>((authDirectory) => ({
  revision: "missing",
  providers: mockGetAuthStatus(authDirectory),
  diagnostics: [],
  conditions: [],
}))

const mockSettleCatalog = mock(async () => {})
const DIRECTORIES = testDirectories("/scratch")
const CREDENTIALS = authDir(DIRECTORIES.userDataRoot, "default")
const lines: string[] = []
const errorLines: string[] = []
let promptAnswer = ""
let promptAnswers: (string | PromptCancelled)[] = []
const promptCalls: { readonly question: string; readonly secret: boolean; readonly signal?: AbortSignal }[] = []
const exitCodes: number[] = []

const dependencies: AuthCommandDependencies = {
  composition: (moduleIds) => composeRealmModuleSnapshot({ moduleIds }),
  actions: {
    credentialProviderDisplayName,
    getAuthStatus: mockGetAuthStatus,
    getAuthStatusWithDiagnostics: mockGetAuthStatusWithDiagnostics,
    loginWithApiKey: mockLoginWithApiKey,
    logoutProvider: mockLogoutProvider,
    providerLoginFlow: mockProviderLoginFlow,
  },
  prompt: async (question, options) => {
    promptCalls.push({ question, secret: options?.secret === true, ...(options?.signal === undefined ? {} : { signal: options.signal }) })
    const next = promptAnswers.shift() ?? promptAnswer
    if (next instanceof PromptCancelled) throw next
    return next
  },
  resolveKey: async (key) => Redacted.make(key),
  settleCatalog: mockSettleCatalog,
  openBrowser: async () => true,
  launcher: refusingLauncher,
  log: (...args) => lines.push(args.map(String).join(" ")),
  error: (...args) => errorLines.push(args.map(String).join(" ")),
  exit: (code) => {
    exitCodes.push(code)
    throw new Error("process.exit")
  },
}

const auth = (args: string[]): Promise<void> => runAuth(args, DIRECTORIES, dependencies)

describe("auth cli", () => {
  beforeEach(() => {
    lines.length = 0
    errorLines.length = 0
    promptAnswer = ""
    promptAnswers = []
    promptCalls.length = 0
    exitCodes.length = 0
    mockLoginWithApiKey.mockClear()
    mockLoginWithChatGPT.mockClear()
    mockLoginWithCopilot.mockClear()
    mockLoginWithXai.mockClear()
    mockLogoutProvider.mockClear()
    mockGetAuthStatus.mockClear()
    mockGetAuthStatusWithDiagnostics.mockClear()
    mockSettleCatalog.mockClear()
  })

  it("shows usage when no command given", async () => {
    await auth([])
    const output = lines.join("\n")
    expect(output).toContain("login --anthropic")
    expect(output).toContain("login --copilot")
    expect(output).toContain("status")
    expect(output).toContain("logout")
  })

  it("prints unknown-command errors and usage together on stderr", async () => {
    await expect(auth(["wat"])).rejects.toThrow("process.exit")
    const output = errorLines.join("\n")
    expect(output).toContain("Unknown auth command: wat")
    expect(output.indexOf("Unknown auth command: wat")).toBeLessThan(output.indexOf("Usage: flywheel auth <command>"))
    expect(lines).toEqual([])
  })

  describe("login", () => {
    it("offers and dispatches a provider only while the config leaves its module on", async () => {
      const accountHome = mkdtempSync(join(tmpdir(), "flywheel-auth-modules-"))
      const userDataRoot = join(accountHome, ".flywheel")
      const directories = { ...DIRECTORIES, accountHome, userDataRoot }
      try {
        mkdirSync(userDataRoot)
        writeFileSync(join(userDataRoot, "flywheel.toml"), 'disabled_modules = ["provider-chatgpt"]\n')
        await runAuth([], directories, dependencies)
        expect(lines.join("\n")).not.toContain("login --chatgpt")
        await expect(runAuth(["login", "--chatgpt"], directories, dependencies)).rejects.toThrow("process.exit")
        expect(mockLoginWithChatGPT).not.toHaveBeenCalled()
        writeFileSync(join(userDataRoot, "flywheel.toml"), "")
        lines.length = 0
        await runAuth([], directories, dependencies)
        expect(lines.join("\n")).toContain("login --chatgpt")
        await runAuth(["login", "--chatgpt"], directories, dependencies)
        expect(mockLoginWithChatGPT).toHaveBeenCalledTimes(1)
      } finally {
        rmSync(accountHome, { recursive: true, force: true })
      }
    })

    it("loads configured custom providers before resolving provider flags", async () => {
      const accountHome = mkdtempSync(join(tmpdir(), "flywheel-auth-custom-"))
      const userDataRoot = join(accountHome, ".flywheel")
      try {
        mkdirSync(userDataRoot)
        writeFileSync(join(userDataRoot, "flywheel.toml"), '[custom_providers.fixture]\nbase_url = "https://example.test/v1"\nmodels = ["fixture-model"]\n')
        promptAnswer = "fixture-key"
        await runAuth(["login", "--provider", "fixture"], {
          ...DIRECTORIES,
          accountHome,
          userDataRoot,
        }, dependencies)
        expect(mockLoginWithApiKey).toHaveBeenCalledWith("fixture", "fixture-key", authDir(userDataRoot, "default"), expect.any(Function), expect.anything(), mockSettleCatalog)

        // A built-in id names its own flag, and the picker lists custom
        // providers under their own heading after every built-in one.
        const builtIn = await runAuth(["login", "--provider", "anthropic_api"], { ...DIRECTORIES, accountHome, userDataRoot }, dependencies).catch((error: unknown) => error)
        expect(builtIn).toEqual(new Error("process.exit"))
        expect(errorLines.at(-1)).toBe('"anthropic_api" is a built-in provider. Run flywheel auth login --anthropic.')
        await runAuth(["logout", "--provider", "anthropic"], { ...DIRECTORIES, accountHome, userDataRoot }, dependencies).catch(() => undefined)
        expect(errorLines.at(-1)).toBe('"anthropic" is a built-in provider. Run flywheel auth logout --anthropic.')
        promptAnswer = "q"
        await runAuth(["login"], { ...DIRECTORIES, accountHome, userDataRoot }, dependencies).catch(() => undefined)
        const picker = lines.join("\n")
        expect(picker.indexOf("Custom providers (flywheel.toml):")).toBeGreaterThan(picker.indexOf("Exa web search (API key)"))
        expect(picker).toMatch(/Custom providers \(flywheel\.toml\):\n {2}13\) fixture \(API key\)/)
      } finally {
        installCustomProviders([])
        rmSync(accountHome, { recursive: true, force: true })
      }
    })

    it("login --anthropic prompts for key and stores via auth actions", async () => {
      promptAnswer = "[redacted secret]"
      await auth(["login", "--anthropic"])
      expect(promptCalls).toEqual([{ question: "Enter the Anthropic API key: ", secret: true }])
      expect(mockLoginWithApiKey).toHaveBeenCalledWith("anthropic_api", promptAnswer, CREDENTIALS, expect.any(Function), expect.anything(), mockSettleCatalog)
      expect(lines.join("\n")).toContain("Anthropic API key stored")
    })

    it("ends a login that the person cancels at the key prompt with a non-zero exit and stores nothing", async () => {
      promptAnswers = [new PromptCancelled("no-answer")]
      await expect(auth(["login", "--openai"])).rejects.toThrow("process.exit")
      promptAnswers = [new PromptCancelled("interrupt")]
      await expect(auth(["login", "--openai"])).rejects.toThrow("process.exit")
      expect(exitCodes).toEqual([1, 130])
      expect(errorLines).toEqual(["Cancelled. Nothing was changed.", "Cancelled. Nothing was changed."])
      expect(mockLoginWithApiKey).not.toHaveBeenCalled()
    })

    it("refuses an option the command does not know instead of ignoring it", async () => {
      promptAnswer = "[redacted secret]"
      await expect(auth(["login", "--anthropic", "--bogus"])).rejects.toThrow("process.exit")
      expect(errorLines[0]).toStartWith("Unknown option for flywheel auth login: --bogus")
      await expect(auth(["login", "--anthropic", "--openai"])).rejects.toThrow("process.exit")
      expect(errorLines[1]).toBe("Name one provider for flywheel auth login.")
      await expect(auth(["status", "--verbose"])).rejects.toThrow("process.exit")
      expect(exitCodes).toEqual([1, 1, 1])
      expect(mockLoginWithApiKey).not.toHaveBeenCalled()
    })

    it("asks again after a picker answer that names no provider", async () => {
      promptAnswers = ["99", "two", "2", "[redacted secret]"]
      await auth(["login"])
      expect(promptCalls.map(({ question }) => question)).toEqual([
        "Enter number (or q to cancel): ",
        "99 is not a choice. Enter a number from 1 to 12 (or q to cancel): ",
        "two is not a choice. Enter a number from 1 to 12 (or q to cancel): ",
        "Enter the OpenAI API key: ",
      ])
      expect(mockLoginWithApiKey).toHaveBeenCalledWith("openai_api", "[redacted secret]", CREDENTIALS, expect.any(Function), expect.anything(), mockSettleCatalog)
    })

    it("login --anthropic rejects empty key", async () => {
      promptAnswer = ""
      await expect(auth(["login", "--anthropic"])).rejects.toThrow("process.exit")
      expect(errorLines.join("\n")).toContain("API key must not be empty")
      expect(mockLoginWithApiKey).not.toHaveBeenCalled()
    })

    it("login --openai stores via auth actions", async () => {
      promptAnswer = "[redacted secret]"
      await auth(["login", "--openai"])
      expect(mockLoginWithApiKey).toHaveBeenCalledWith("openai_api", promptAnswer, CREDENTIALS, expect.any(Function), expect.anything(), mockSettleCatalog)
      expect(lines.join("\n")).toContain("OpenAI API key stored")
    })

    it("login --google stores via auth actions", async () => {
      promptAnswer = "AIza-google-key"
      await auth(["login", "--google"])
      expect(mockLoginWithApiKey).toHaveBeenCalledWith("google_api", promptAnswer, CREDENTIALS, expect.any(Function), expect.anything(), mockSettleCatalog)
      expect(lines.join("\n")).toContain("Google API key stored")
    })

    it("login --openrouter stores via auth actions", async () => {
      promptAnswer = "[redacted secret]"
      await auth(["login", "--openrouter"])
      expect(mockLoginWithApiKey).toHaveBeenCalledWith("openrouter", promptAnswer, CREDENTIALS, expect.any(Function), expect.anything(), mockSettleCatalog)
      expect(lines.join("\n")).toContain("OpenRouter API key stored")
    })

    it("login --chatgpt opens browser flow", async () => {
      await auth(["login", "--chatgpt"])
      expect(mockLoginWithChatGPT).toHaveBeenCalledWith(expect.objectContaining({
        authDir: CREDENTIALS,
        writeAccess: expect.anything(),
        resolveKey: expect.any(Function),
        openBrowser: expect.any(Function),
      }))
      const output = lines.join("\n")
      expect(output).toContain("Opening browser for ChatGPT Subscription authentication")
      expect(output).toContain("Logged in via ChatGPT Subscription")
      expect(mockLoginWithChatGPT).toHaveBeenCalledWith(expect.objectContaining({ settle: mockSettleCatalog }))
    })

    it("login --chatgpt prints browser URL as fallback", async () => {
      await auth(["login", "--chatgpt"])
      const output = lines.join("\n")
      expect(output).toContain("If a browser did not open, copy this URL:")
      expect(output).toContain("https://auth.openai.com/authorize?state=test")
      expect(output).toContain("Waiting for authorization...")
    })

    it("login --chatgpt takes a pasted code, and its prompt closes when the login ends", async () => {
      mockLoginWithChatGPT.mockImplementationOnce(async (options) => {
        expect(await options.onManualCodeInput?.()).toBe("code#state")
        return AUTH_CONTEXT
      })
      promptAnswers = ["code#state"]
      await auth(["login", "--chatgpt"])
      expect(promptCalls.map(({ question }) => question)).toEqual(["Paste the code that the page shows, or finish in the browser: "])
      expect(promptCalls[0]?.signal?.aborted).toBe(true)
      expect(lines.join("\n")).toContain("Logged in via ChatGPT Subscription")
    })

    it("login --chatgpt closes the code prompt before it asks the replace question, and a no keeps the free-plan account (PI-MODEL-069)", async () => {
      const seen: { pasteClosed?: boolean; flowCancelled?: boolean }[] = []
      const flow = async (options: Parameters<typeof mockLoginWithChatGPT>[0]) => {
        void options.onManualCodeInput?.().catch(() => {})
        const replace = await options.confirmReplace?.(FREE_PLAN_REPLACE_QUESTION)
        seen.push({ pasteClosed: promptCalls[0]?.signal?.aborted, flowCancelled: options.signal?.aborted })
        if (replace !== true) throw new Error("declined")
        return AUTH_CONTEXT
      }
      mockLoginWithChatGPT.mockImplementationOnce(flow)
      promptAnswers = ["", "y"]
      await auth(["login", "--chatgpt"])
      expect(promptCalls.map(({ question }) => question)).toEqual(["Paste the code that the page shows, or finish in the browser: ", `${FREE_PLAN_REPLACE_QUESTION} Replace it? [y/N] `])
      expect(seen).toEqual([{ pasteClosed: true, flowCancelled: false }])
      expect(lines.join("\n")).toContain("Logged in via ChatGPT Subscription")

      lines.length = 0
      promptCalls.length = 0
      mockLoginWithChatGPT.mockImplementationOnce(flow)
      promptAnswers = ["", "n"]
      await auth(["login", "--chatgpt"])
      expect(exitCodes).toEqual([])
      expect(lines).toContain(keptFreePlanMessage("ChatGPT Subscription"))
      expect(lines.join("\n")).not.toContain("Logged in via")
    })

    it("login --chatgpt cancels the login when Ctrl+C ends the code prompt", async () => {
      let cancelled: boolean | undefined
      mockLoginWithChatGPT.mockImplementationOnce(async (options) => {
        await options.onManualCodeInput?.().catch(() => {})
        cancelled = options.signal?.aborted
        return AUTH_CONTEXT
      })
      promptAnswers = [new PromptCancelled("interrupt")]
      await auth(["login", "--chatgpt"])
      expect(cancelled).toBe(true)
    })

    it("login --chatgpt exits as an interrupt when the login fails after Ctrl+C", async () => {
      mockLoginWithChatGPT.mockImplementationOnce(async (options) => {
        await options.onManualCodeInput?.().catch(() => {})
        throw new Error("Login cancelled")
      })
      promptAnswers = [new PromptCancelled("interrupt")]
      await expect(auth(["login", "--chatgpt"])).rejects.toThrow("process.exit")
      expect(exitCodes).toEqual([130])
    })

    it("login --copilot triggers device code flow", async () => {
      await auth(["login", "--copilot"])
      expect(mockLoginWithCopilot).toHaveBeenCalledWith(expect.objectContaining({
        authDir: CREDENTIALS,
        writeAccess: expect.anything(),
        resolveKey: expect.any(Function),
        openBrowser: expect.any(Function),
      }))
      const output = lines.join("\n")
      expect(output).toContain("device code flow")
      expect(output).toContain("ABCD-1234")
      expect(output).toContain("https://github.com/login/device")
      expect(output).toContain("Logged in via Copilot Subscription")
      expect(mockLoginWithCopilot).toHaveBeenCalledWith(expect.objectContaining({ settle: mockSettleCatalog }))
    })

    it("login --supergrok triggers the xAI device code flow", async () => {
      await auth(["login", "--supergrok"])
      expect(mockLoginWithXai).toHaveBeenCalledWith(expect.objectContaining({
        authDir: CREDENTIALS,
        writeAccess: expect.anything(),
        resolveKey: expect.any(Function),
        openBrowser: expect.any(Function),
      }))
      const output = lines.join("\n")
      expect(output).toContain("SuperGrok Subscription device code flow")
      expect(output).toContain("WXYZ-5678")
      expect(output).toContain("https://auth.x.ai/activate?code=WXYZ-5678")
      expect(output).toContain("Logged in via SuperGrok Subscription")
      expect(mockLoginWithXai).toHaveBeenCalledWith(expect.objectContaining({ settle: mockSettleCatalog }))
    })

    it("prints success only after catalog settlement resolves", async () => {
      promptAnswer = "sk-ant-test-key"
      const settlement = Promise.withResolvers<void>()
      mockLoginWithApiKey.mockImplementationOnce(async (...args) => {
        await args[5]({ kind: "singleton", providerId: "anthropic_api" }, CREDENTIALS)
        return AUTH_CONTEXT
      })
      mockSettleCatalog.mockImplementationOnce(() => settlement.promise)
      const login = auth(["login", "--anthropic"])
      await Promise.resolve()
      expect(lines.join("\n")).not.toContain("stored")
      settlement.resolve()
      await login
      expect(lines.join("\n")).toContain("Anthropic API key stored")
    })

    it("does not print success when catalog settlement rejects, and says why the login failed", async () => {
      promptAnswer = "sk-ant-test-key"
      mockLoginWithApiKey.mockImplementationOnce(async (...args) => {
        await args[5]({ kind: "singleton", providerId: "anthropic_api" }, CREDENTIALS)
        return AUTH_CONTEXT
      })
      mockSettleCatalog.mockRejectedValueOnce(new Error("catalog unavailable"))
      await expect(auth(["login", "--anthropic"])).rejects.toThrow("process.exit")
      expect(lines.join("\n")).not.toContain("stored")
      expect(errorLines).toEqual(["Login failed: catalog unavailable"])
    })

    it("login with no flags prints provider list", async () => {
      promptAnswer = "q"
      await expect(auth(["login"])).rejects.toThrow("process.exit")
      expect(errorLines).toEqual(["Cancelled. Nothing was changed."])
      const output = lines.join("\n")
      // Status order, the same order the auth status view lists providers in.
      expect(output).toContain("1) Anthropic (API key)")
      expect(output).toContain("2) OpenAI (API key)")
      expect(output).toContain("3) Anthropic Subscription (external login)")
      expect(output).toContain("4) OpenCode Go (API key)")
      expect(output).toContain("5) OpenRouter (API key)")
      expect(output).toContain("6) DeepSeek (API key)")
      expect(output).toContain("7) Google (API key)")
      expect(output).toContain("8) Google Vertex (API key)")
      expect(output).toContain("9) ChatGPT (browser OAuth)")
      expect(output).toContain("10) GitHub Copilot (device code)")
      expect(output).toContain("11) SuperGrok (device code)")
      expect(output).toContain("12) Exa web search (API key)")
    })
  })

  describe("status", () => {
    it("prints the effective profile and its resolution source", async () => {
      await auth(["status"])
      expect(lines).toContain("Profile: Default (default)")
      expect(lines).toContain("Available profiles: Default")
    })

    it("refuses an environment-selected profile that does not exist, as login does", async () => {
      const previous = process.env.FLYWHEEL_AUTH_PROFILE
      process.env.FLYWHEEL_AUTH_PROFILE = "Defualt"
      try {
        await expect(auth(["status"])).rejects.toThrow("process.exit")
      } finally {
        if (previous === undefined) delete process.env.FLYWHEEL_AUTH_PROFILE
        else process.env.FLYWHEEL_AUTH_PROFILE = previous
      }
      expect(errorLines).toEqual(['FLYWHEEL_AUTH_PROFILE names the auth profile "Defualt", which does not exist. Available profiles: Default.'])
      expect(lines).toEqual([])
    })

    it("reports stale provider diagnostics without exposing credential material", async () => {
      mockGetAuthStatusWithDiagnostics.mockReturnValueOnce({
        revision: "missing",
        providers: mockGetAuthStatus(CREDENTIALS),
        conditions: [],
        diagnostics: [{
          kind: "unknown_provider",
          providerId: "removed_provider",
          message: 'Credential provider "removed_provider" is not installed. Remove its entry from auth.json.',
        }],
      })
      await auth(["status"])
      expect(lines).toContain('Warning: Credential provider "removed_provider" is not installed. Remove its entry from auth.json.')
      expect(lines.join("\n")).not.toContain("[redacted stale secret]")
    })

    it("shows all 6 providers with correct indicators", async () => {
      mockGetAuthStatus.mockReturnValue([
        status("anthropic_api", "stored_key"),
        status("openai_api", "unconfigured"),
        status("google_api", "unconfigured"),
        status("openrouter", "unconfigured"),
        status("chatgpt", "oauth"),
        { ...status("github_copilot", "oauth"), expired: true },
      ])
      await auth(["status"])
      expect(lines).toContain("Anthropic API Key: stored")
      expect(lines).toContain("OpenAI API Key: not configured")
      expect(lines).toContain("Google API Key: not configured")
      expect(lines).toContain("OpenRouter API Key: not configured")
      expect(lines).toContain("ChatGPT Subscription: active")
      expect(lines).toContain("Copilot Subscription: expired")
    })

    it("labels invalid stored credentials distinctly from unconfigured", async () => {
      mockGetAuthStatus.mockReturnValue([
        status("anthropic_api", "invalid"),
        status("openai_api", "unconfigured"),
        status("google_api", "unconfigured"),
        status("openrouter", "unconfigured"),
        status("chatgpt", "unconfigured"),
        status("github_copilot", "unconfigured"),
      ])
      await auth(["status"])
      expect(lines).toContain("Anthropic API Key: invalid credential")
      expect(lines).toContain("OpenAI API Key: not configured")
    })

  })

  describe("logout", () => {
    it("reports no stored credentials for the synthetic default profile", async () => {
      const accountHome = mkdtempSync(join(tmpdir(), "flywheel-auth-logout-"))
      try {
        await runAuth(["logout", "--anthropic"], {
          ...DIRECTORIES,
          accountHome,
          userDataRoot: join(accountHome, ".flywheel"),
        }, dependencies)
        expect(mockLogoutProvider).not.toHaveBeenCalled()
        expect(lines).toContain("No stored credentials for Anthropic API Key.")
      } finally {
        rmSync(accountHome, { recursive: true, force: true })
      }
    })

    it("logout --anthropic removes credential", async () => {
      mockGetAuthStatus.mockReturnValue([
        status("anthropic_api", "stored_key"),
        status("openai_api", "unconfigured"),
        status("google_api", "unconfigured"),
        status("openrouter", "unconfigured"),
        status("chatgpt", "unconfigured"),
        status("github_copilot", "unconfigured"),
      ])
      await auth(["logout", "--anthropic"])
      expect(mockLogoutProvider).toHaveBeenCalledWith("anthropic_api", CREDENTIALS, expect.any(Function), expect.anything())
      expect(lines.join("\n")).toContain("Anthropic API Key credentials removed")
    })

    it("logout --copilot removes credential", async () => {
      mockGetAuthStatus.mockReturnValue([
        status("anthropic_api", "unconfigured"),
        status("openai_api", "unconfigured"),
        status("google_api", "unconfigured"),
        status("openrouter", "unconfigured"),
        status("chatgpt", "unconfigured"),
        status("github_copilot", "oauth"),
      ])
      await auth(["logout", "--copilot"])
      expect(mockLogoutProvider).toHaveBeenCalledWith("github_copilot", CREDENTIALS, expect.any(Function), expect.anything())
      expect(lines.join("\n")).toContain("Copilot Subscription credentials removed")
    })

    it("logout treats an unconfigured provider as no stored credentials", async () => {
      mockGetAuthStatus.mockReturnValue([
        status("anthropic_api", "unconfigured"),
        status("openai_api", "unconfigured"),
        status("google_api", "unconfigured"),
        status("openrouter", "unconfigured"),
        status("chatgpt", "unconfigured"),
        status("github_copilot", "unconfigured"),
      ])
      await auth(["logout", "--anthropic"])
      expect(mockLogoutProvider).not.toHaveBeenCalled()
      expect(lines.join("\n")).toContain("No stored credentials for Anthropic API Key")
    })

  })
})
