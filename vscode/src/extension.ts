import { homedir } from "node:os"
import * as vscode from "vscode"
import { Redacted } from "effect"

import { createRuntimeConnection, type RuntimeConnection } from "../../src/protocol/client/connection.js"
import { CATALOG_PALETTE_COMMANDS, type CatalogPaletteCommand } from "./catalog-commands.js"
import { openSheetCommand, type ClientCommand } from "../../src/protocol/client/host-contract.js"
import { summarizeProviders } from "../../src/protocol/client/provider-summary.js"
import { installedLauncherPath, updateRepository } from "../../src/protocol/installation.js"
import { createAuthNotificationCoordinator, type AuthNotificationCoordinator } from "./providers/auth-notification-coordinator.js"
import { nodeSocketLayer } from "./runtime/node-socket.js"
import { MINIMUM_RUNTIME_VERSION, resolveRuntime } from "./runtime/runtime-resolver.js"
import { createRuntimeRecovery } from "./runtime/runtime-recovery.js"
import { ensureAccountRuntime, prepareAccountRuntime, type AccountSupervisorOptions } from "./runtime/supervisor.js"
import { installFlywheel } from "./runtime/bootstrap-install.js"
import { establishRuntime, type HostPhase } from "./runtime/host-lifecycle.js"
import { pickProblems, pickSymbol } from "./context/attach.js"
import { pickFile, type FileItem } from "./context/file-picker.js"
import { FlywheelCodeActions } from "./context/code-actions.js"
import { describeProblem, describeSelection } from "./context/editor-context.js"
import { statusPage, statusReading, type PageActionId } from "./webview/status-page.js"
import { ChatViewProvider } from "./webview/chat-view.js"
import { runSshAutoInstallOffer, shouldOfferSshAutoInstall, sshDefaultsWriteFailure, updateSshDefaultExtensions } from "./ssh-default-extensions.js"
import { sessionChoices, type SessionChoice } from "./session-choices.js"
import { createModuleContextPublisher } from "./module-context.js"

const REMOTE_SSH_EXTENSION_ID = "ms-vscode-remote.remote-ssh"
const SSH_AUTO_INSTALL_OFFERED_KEY = "flywheel.sshAutoInstallOffered"
const SSH_DEFAULT_EXTENSIONS_SETTING = "defaultExtensions"
const INSTALL_GUIDE = "https://github.com/wsauret/flywheel#install"
/** As many rows as the client's `@` panel shows, and a few more, because a
 *  quick pick is taller. */
const FILE_ROWS = 50

/** The host's own runtime connection, while a runtime serves this window.
 *  It feeds the auth notification coordinator, which raises editor
 *  notifications while the client is hidden, and the commands that act on
 *  the catalog: workflow launch and the chat pickers. Every provider, usage,
 *  model, and profile surface is a sheet inside the client. The chat client
 *  runs inside its webview with its own connection; this one never
 *  reconciles chat state. */
interface LiveRuntime {
  readonly connection: RuntimeConnection
  readonly coordinator: AuthNotificationCoordinator
  dispose(): Promise<void>
}

let live: LiveRuntime | undefined
let chat: ChatViewProvider | undefined

function sshDefaultExtensions(): readonly string[] {
  return vscode.workspace
    .getConfiguration("remote.SSH")
    .get<readonly string[]>(SSH_DEFAULT_EXTENSIONS_SETTING, [])
}

const SSH_AUTO_INSTALL_ON = "Flywheel will install automatically on new SSH hosts. Reconnect an open SSH window to apply it."

async function setSshAutoInstall(context: vscode.ExtensionContext, output: vscode.OutputChannel, enabled: boolean): Promise<boolean> {
  const configuration = vscode.workspace.getConfiguration("remote.SSH")
  const result = await updateSshDefaultExtensions({
    enabled,
    remoteSshInstalled: vscode.extensions.getExtension(REMOTE_SSH_EXTENSION_ID) !== undefined,
    defaultExtensions: sshDefaultExtensions(),
    extensionId: context.extension.id,
    write: (defaultExtensions) =>
      configuration.update(SSH_DEFAULT_EXTENSIONS_SETTING, defaultExtensions, vscode.ConfigurationTarget.Global),
  })
  if (result.ok) return true

  if (result.reason === "remote_ssh_missing") {
    void vscode.window.showInformationMessage(enabled
      ? "Install the Microsoft Remote - SSH extension first."
      : "Nothing installs Flywheel on SSH hosts while the Microsoft Remote - SSH extension is not installed.")
  } else {
    output.appendLine(`could not write remote.SSH.defaultExtensions: ${String(result.cause)}`)
    void vscode.window.showErrorMessage(`Flywheel could not change the Remote - SSH default extensions. ${sshDefaultsWriteFailure(result.cause)}`)
  }
  return false
}

async function offerSshAutoInstall(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (
    !shouldOfferSshAutoInstall({
      isRemoteWindow: vscode.env.remoteName !== undefined,
      remoteSshInstalled: vscode.extensions.getExtension(REMOTE_SSH_EXTENSION_ID) !== undefined,
      alreadyOffered: context.globalState.get(SSH_AUTO_INSTALL_OFFERED_KEY) === true,
      defaultExtensions: sshDefaultExtensions(),
      extensionId: context.extension.id,
    })
  ) {
    return
  }
  await runSshAutoInstallOffer({
    ask: async () => {
      const choice = await vscode.window.showInformationMessage("Install Flywheel automatically on future SSH hosts?", "Install Automatically", "Not Now")
      return choice === undefined ? undefined : choice === "Install Automatically" ? "accept" : "decline"
    },
    enable: () => setSshAutoInstall(context, output, true),
    recordOffered: () => context.globalState.update(SSH_AUTO_INSTALL_OFFERED_KEY, true),
    confirm: () => { void vscode.window.showInformationMessage(SSH_AUTO_INSTALL_ON) },
  })
}

/**
 * VS Code invokes this extension-host entry.
 * @externalHost
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Flywheel", { log: true })
  context.subscriptions.push(output)

  // `secondarySidebar` arrived in VS Code 1.106. Older versions silently ignore
  // the contribution, which would leave the panel with nowhere to live, so they
  // get the activity bar instead.
  const [major = 0, minor = 0] = vscode.version.split(".").map(Number)
  const supportsSecondarySidebar = major > 1 || (major === 1 && minor >= 106)
  if (!supportsSecondarySidebar) {
    await vscode.commands.executeCommand("setContext", "flywheel:doesNotSupportSecondarySidebar", true)
  }

  // One phase drives the panel and the status bar item, so the two never
  // disagree about why there is no client.
  let phase: HostPhase = { kind: "starting" }
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  // The item always leads to the panel, which states the cause in full.
  status.command = "flywheel.focusChat"
  status.show()
  context.subscriptions.push(status)
  const paintStatus = (): void => {
    const reading = statusReading(phase, live?.connection.health)
    status.text = `$(${reading.icon}) Flywheel`
    status.tooltip = reading.sentence
    // Without this a screen reader reads the icon's name aloud.
    status.accessibilityInformation = { label: `Flywheel: ${reading.sentence}`, role: "status" }
  }

  const panel = new ChatViewProvider((line) => output.appendLine(line), (id) => { void runPageAction(id) })
  chat = panel
  context.subscriptions.push(panel)
  // The panel is registered before anything starts, so it always says what
  // the editor is doing: installing, starting, why it cannot, or the client.
  // Both ids are registered because only the manifest knows which one this
  // VS Code contributed; the other simply never resolves.
  for (const viewType of ChatViewProvider.viewTypes) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(viewType, panel, {
        // The client lives in the webview, so hiding the panel must not unload
        // it: the connection, the scroll position, and the composer draft all
        // survive a hidden panel this way.
        webviewOptions: { retainContextWhenHidden: true },
      }),
    )
  }

  const enterPhase = (next: HostPhase): void => {
    phase = next
    if (next.kind !== "ready") panel.show({ kind: "page", page: statusPage(next) })
    paintStatus()
  }

  // Where the installer places the launcher, computed on the machine the
  // extension host runs on, which over SSH, WSL, or a container is the remote.
  const launcher = installedLauncherPath(process.platform, process.env, homedir())
  const supervision = (executable: string, projectRoot: string): AccountSupervisorOptions => ({
    executable,
    projectRoot,
    minimumVersion: MINIMUM_RUNTIME_VERSION,
    log: output,
  })

  /** Starts the host connection for a runtime that listens, and shows its
   *  client in the panel. */
  const connect = (ready: Extract<HostPhase, { readonly kind: "ready" }>): LiveRuntime => {
    output.appendLine(`account service at ${ready.started.target.socketPath}`)
    const target = {
      socketPath: ready.started.target.socketPath,
      projectRoot: ready.started.target.projectRoot,
      credential: Redacted.value(ready.started.target.credential),
    }
    const logDiagnostic = (message: string, detail?: unknown): void => {
      output.appendLine(`${message}${detail === undefined ? "" : `: ${String(detail)}`}`)
    }
    const recovery = createRuntimeRecovery({ ensure: () => ensureAccountRuntime(supervision(ready.runtime.executable, target.projectRoot)), log: output })
    const connection = createRuntimeConnection({ socket: nodeSocketLayer(target), onDiagnostic: logDiagnostic, ensureRuntime: recovery.ensureRuntime })
    const coordinator = createAuthNotificationCoordinator({
      connection,
      isForegroundSafe: () => vscode.window.state.focused && panel.latestSummary?.busy !== true,
      presentNotification: async (toast) => {
        const chosen = await vscode.window.showWarningMessage(toast.text, ...(toast.action ? [toast.action] : []))
        return toast.action !== undefined && chosen === toast.action
      },
      open: (command) => { panel.revealCommand(command) },
      onError: (cause) => { output.appendLine(`auth coordinator failed: ${String(cause)}`) },
    })
    const stops = [
      connection.onStateChange((state) => {
        recovery.observeState(state)
        // A client the account service could not name mounts once the
        // service answers again; nothing else on screen has to change.
        if (state === "connected") panel.retryClient()
      }),
      connection.onHealthChange(paintStatus),
      // The setup checklist's provider step reads the runtime's own auth
      // state, so it is checked whether or not the panel was ever opened.
      coordinator.onAuthChange((snapshot) => {
        const connected = snapshot !== undefined && summarizeProviders(snapshot.auth).some((provider) => provider.connected && !provider.expired)
        void vscode.commands.executeCommand("setContext", "flywheel.hasProvider", connected)
      }),
    ]
    const publishModules = createModuleContextPublisher((key, value) => { void vscode.commands.executeCommand("setContext", key, value) })
    const summaries = [
      panel.onSummary(() => { coordinator.foregroundAvailable() }),
      panel.onSummary((summary) => { publishModules(summary.moduleIds) }),
      vscode.window.onDidChangeWindowState(() => { coordinator.foregroundAvailable() }),
    ]
    panel.show({ kind: "client", target, ensureRuntime: recovery.ensureRuntime })
    return {
      connection,
      coordinator,
      async dispose() {
        for (const stop of stops) stop()
        for (const summary of summaries) summary.dispose()
        coordinator.dispose()
        await connection.close()
      },
    }
  }

  // Each start runs after the one before it settles, and a start that a
  // newer request superseded before it began does not run at all, so two
  // installers or two `serve ensure` runs never race.
  let wanted = 0
  let starts = Promise.resolve()
  const start = (): Promise<void> => {
    const request = ++wanted
    starts = starts.then(async () => {
      if (request !== wanted) return
      const previous = live
      live = undefined
      await previous?.dispose()
      const settled = await establishRuntime({
        projectRoot: resolveProjectRoot,
        resolve: () => resolveRuntime({ configured: vscode.workspace.getConfiguration("flywheel").get<string>("executablePath"), launcher, minimumVersion: MINIMUM_RUNTIME_VERSION }),
        install: async () => {
          // The extension build always compiles in a release repository
          // (vscode/scripts/build.ts); FLYWHEEL_REPO overrides it.
          const repository = updateRepository()
          if (repository === undefined) return { ok: false, failure: { kind: "fetch_failed", url: "", detail: "This extension build names no Flywheel release repository. Set FLYWHEEL_REPO to install Flywheel." } }
          const installed = await installFlywheel({
            platform: process.platform,
            repository,
            launcher,
            minimumVersion: MINIMUM_RUNTIME_VERSION,
            env: process.env,
            onOutput: (line) => output.appendLine(line),
          })
          return installed.ok ? { ok: true, runtime: { executable: launcher, version: installed.version, source: "launcher" } } : installed
        },
        start: (runtime, projectRoot, onStep) => {
          output.appendLine(`runtime ${runtime.version} (${runtime.source}) at ${runtime.executable}`)
          return prepareAccountRuntime({ ...supervision(runtime.executable, projectRoot), onPhase: onStep })
        },
        now: Date.now,
      }, enterPhase)
      if (settled.kind === "ready") {
        live = connect(settled)
        paintStatus()
        return
      }
      const page = statusPage(settled)
      output.appendLine(`${page.title}: ${page.body}`)
      // A window with no folder is not a fault, and a visible panel already
      // states the cause: a notice there would say it twice, and would stay
      // after the cause is gone.
      if (settled.failure.kind !== "no_folder" && !panel.visible) void noticeUnavailable(page.title)
    }).catch((cause: unknown) => { output.appendLine(`Flywheel could not start: ${String(cause)}`) })
    return starts
  }

  /** One short notice that points at the panel, where the cause and its
   *  remedy are stated once. */
  const noticeUnavailable = async (title: string): Promise<void> => {
    const choice = await vscode.window.showErrorMessage(`Flywheel: ${title}.`, "Show Details")
    if (choice === "Show Details") await panel.reveal()
  }

  const runPageAction = async (id: PageActionId): Promise<void> => {
    switch (id) {
      case "log":
        output.show()
        return
      case "retry":
        await start()
        return
      case "openFolder":
        await vscode.commands.executeCommand("workbench.action.files.openFolder")
        return
      case "executableSetting":
        await vscode.commands.executeCommand("workbench.action.openSettings", "flywheel.executablePath")
        return
      case "projectRootSetting":
        await vscode.commands.executeCommand("workbench.action.openSettings", "flywheel.projectRoot")
        return
      case "installGuide":
        await vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE))
        return
      case "showExtension":
        await vscode.commands.executeCommand("extension.open", context.extension.id)
    }
  }

  /** A palette command that acts in the client. Without a runtime the panel
   *  opens on the page that says why there is none. */
  const inClient = (command: ClientCommand) => () => { panel.revealCommand(command) }
  /** A palette command that runs a command of the runtime's catalog, the way its command menu entry does. */
  const catalogCommand = (id: CatalogPaletteCommand) => vscode.commands.registerCommand(id, inClient({ type: "invokeCommand", id: CATALOG_PALETTE_COMMANDS[id] }))
  /** A palette command that needs the host's connection. */
  const withRuntime = (run: (runtime: LiveRuntime) => Promise<void>) => async () => {
    if (live) await run(live)
    else await panel.reveal()
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("flywheel.showRuntimeLog", () => output.show()),
    vscode.commands.registerCommand("flywheel.showWelcome", async () => {
      // A rendered document rather than the walkthrough. VS Code puts a
      // walkthrough's real content in a media pane beside its step list, and
      // with the panel open beside it there is no room for one, so a reader
      // gets the one-line step titles and nothing else, which is how the most
      // interesting product in the window came across as a thin mystery.
      const doc = vscode.Uri.joinPath(context.extensionUri, "docs", "about-flywheel.md")
      try {
        await vscode.commands.executeCommand("markdown.showPreview", doc)
      } catch (cause) {
        output.appendLine(`could not render the guide: ${String(cause)}`)
        // Markdown preview is built in, but a user can disable it. The source
        // still reads fine.
        await vscode.window.showTextDocument(doc, { preview: true })
      }
    }),
    vscode.commands.registerCommand("flywheel.showSetupChecklist", () =>
      vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#flywheel.setup`, false),
    ),
    vscode.commands.registerCommand("flywheel.enableSshAutoInstall", async () => {
      const updated = await setSshAutoInstall(context, output, true)
      if (!updated) return
      await context.globalState.update(SSH_AUTO_INSTALL_OFFERED_KEY, true)
      void vscode.window.showInformationMessage(SSH_AUTO_INSTALL_ON)
    }),
    vscode.commands.registerCommand("flywheel.disableSshAutoInstall", async () => {
      const updated = await setSshAutoInstall(context, output, false)
      if (!updated) return
      await context.globalState.update(SSH_AUTO_INSTALL_OFFERED_KEY, true)
      void vscode.window.showInformationMessage("Flywheel will no longer install automatically on new SSH hosts.")
    }),
    vscode.languages.registerCodeActionsProvider("*", new FlywheelCodeActions(), {
      providedCodeActionKinds: FlywheelCodeActions.kinds,
    }),
    vscode.commands.registerCommand("flywheel.focusChat", () => panel.focusComposer()),
    ...panel.registerChangesCommands((title, run) => withRuntime((runtime) => pickSession(runtime, title, run))()),
    catalogCommand("flywheel.newSession"),
    catalogCommand("flywheel.compact"),
    vscode.commands.registerCommand("flywheel.reconnect", async () => {
      // Without a runtime there is nothing to reattach to, so this starts
      // one, the way Try again does.
      if (!live) {
        await start()
        return
      }
      // Two connections, one runtime: the host's own and the client's. Both
      // drop their attach and take the next one.
      live.connection.reconnect()
      panel.command({ type: "reconnect" })
      void vscode.window.showInformationMessage("Flywheel is reattaching to the runtime.")
    }),
    // The client's command panel is the one settings surface; the palette
    // command lands the user in it rather than maintaining a second quick-pick
    // of the same rows.
    catalogCommand("flywheel.settings"),
    vscode.commands.registerCommand("flywheel.interruptWorkflow", inClient({ type: "interruptWorkflow" })),
    catalogCommand("flywheel.profiles"),
    catalogCommand("flywheel.browseModels"),
    vscode.commands.registerCommand("flywheel.pickProviderModels", inClient(openSheetCommand("provider-models"))),
    catalogCommand("flywheel.signIn"),
    catalogCommand("flywheel.showUsage"),
    catalogCommand("flywheel.status"),
    catalogCommand("flywheel.learn"),
    catalogCommand("flywheel.drainPapercuts"),
    vscode.commands.registerCommand("flywheel.switchSession", withRuntime((runtime) => pickSession(runtime, "Switch to chat", async (row) => {
      panel.revealCommand({ type: "selectSession", sessionId: row.id })
    }))),
    vscode.commands.registerCommand("flywheel.renameSession", withRuntime((runtime) => pickSession(runtime, "Edit chat description", async (row) => {
      const title = await vscode.window.showInputBox({
        title: "Edit chat description",
        value: row.title,
        prompt: "Change the longer description. The tab title stays the same.",
        validateInput: (value) => (value.trim().length === 0 ? "A description cannot be empty." : undefined),
      })
      if (title === undefined) return
      await runtime.connection.dispatch({ type: "session.rename", sessionId: row.id, title: title.trim() })
    }))),
    vscode.commands.registerCommand("flywheel.deleteSession", withRuntime((runtime) => pickSession(runtime, "Delete chat", async (row) => {
      const confirmed = await vscode.window.showWarningMessage(
        `Delete "${row.title}"?`,
        { modal: true, detail: "The conversation and its history are removed. This cannot be undone. Files it changed on disk are not touched." },
        "Delete",
      )
      if (confirmed !== "Delete") return
      // The client reconciles from the session patch: a deleted selection
      // falls to whatever the catalog still holds.
      await runtime.connection.dispatch({ type: "session.delete", sessionId: row.id })
    }))),
    vscode.commands.registerCommand("flywheel.closeSession", withRuntime((runtime) => pickSession(runtime, "Close chat", async (row) => {
      await runtime.connection.dispatch({ type: "session.close", sessionId: row.id })
    }, "open"))),
    vscode.commands.registerCommand("flywheel.interrupt", inClient({ type: "interrupt" })),
    vscode.commands.registerCommand("flywheel.addSelectionToChat", () => addSelectionToChat()),
    vscode.commands.registerCommand("flywheel.explainSelection", () => explainSelection()),
    vscode.commands.registerCommand("flywheel.fixProblem", (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => fixProblem(uri, diagnostic)),
    vscode.commands.registerCommand("flywheel.addFiles", withRuntime(async (runtime) => {
      const mention = await pickFile(
        async (query) => (await runtime.connection.query({ type: "projectFiles", request: { query, limit: FILE_ROWS } })).entries,
        () => vscode.window.createQuickPick<FileItem>(),
      )
      if (mention !== undefined) panel.insertText(mention)
    })),
    vscode.commands.registerCommand("flywheel.addSymbol", async () => {
      const symbol = await pickSymbol()
      if (symbol) panel.insertText(symbol)
    }),
    vscode.commands.registerCommand("flywheel.addProblems", async () => {
      const problems = await pickProblems()
      if (problems) panel.insertText(problems)
    }),
    catalogCommand("flywheel.pickModel"),
    // A corrected setting or a newly opened folder starts Flywheel again, the
    // same way a fresh window does: the panel and the status bar follow.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("flywheel.executablePath") || event.affectsConfiguration("flywheel.projectRoot")) void start()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void start() }),
  )

  paintStatus()
  void start()

  // Shown once, ever. An extension that explains itself on every window is an
  // extension the user learns to dismiss without reading.
  if (context.globalState.get("flywheel.welcomed") !== true) {
    void context.globalState.update("flywheel.welcomed", true)
    // On a new profile the sidebar can open with no view container chosen,
    // so the panel is opened by name: the first thing a new user sees of
    // Flywheel is the panel saying what it is doing, never an empty box.
    void panel.reveal()
    void vscode.commands.executeCommand("flywheel.showWelcome")
    // The checklist alongside it, for someone who would rather be walked
    // through than read. Second, because it is the thinner of the two.
    void vscode.commands.executeCommand("flywheel.showSetupChecklist")
  }

  void offerSshAutoInstall(context, output).catch((cause) => {
    output.appendLine(`could not offer automatic Remote SSH installation: ${String(cause)}`)
  })
}

/**
 * VS Code invokes this extension-host entry.
 * @externalHost
 */
export async function deactivate(): Promise<void> {
  chat?.dispose()
  // The runtime is deliberately left running. It reaps itself once it has held
  // no client and run nothing for its idle window, which is what lets a window
  // reload reattach to a turn still in flight instead of aborting it.
  await live?.dispose()
}

/** Sends the current selection with enough context for the agent to find it
 *  again: the path it came from and the lines it covers. */
function addSelectionToChat(): void {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Flywheel: select some code first.")
    return
  }
  chat?.insertText(describeSelection(editor))
}

function explainSelection(): void {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Flywheel: select some code first.")
    return
  }
  chat?.insertText(`Explain this.\n\n${describeSelection(editor)}`)
  chat?.focusComposer()
}

async function fixProblem(uri: vscode.Uri, diagnostic: vscode.Diagnostic): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri)
  chat?.insertText(describeProblem(document, diagnostic))
  chat?.focusComposer()
}

/** One runtime serves one project root. A multi-root workspace picks its first
 *  folder rather than guessing which of several the user meant; Flywheel's own
 *  project selection (PI-INTERACTION-068) owns the rest of the question. */
function resolveProjectRoot(): string | undefined {
  const configured = vscode.workspace.getConfiguration("flywheel").get<string>("projectRoot")
  if (configured && configured.trim().length > 0) return configured.trim()
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

/** Asks which chat, then does the thing.
 *
 *  Every one of these commands can be run from the palette with no chat
 *  selected and no panel open, so none of them may assume a current session.
 *  The list comes from the runtime's catalog through the host's own
 *  connection, because the client's selection is not the question here. */
async function pickSession(
  runtime: LiveRuntime,
  title: string,
  run: (row: { readonly id: string; readonly title: string }) => Promise<void>,
  among: "all" | "open" = "all",
): Promise<void> {
  const snapshot = await runtime.connection.query({ type: "snapshot" })
  const items: readonly SessionChoice[] = sessionChoices(snapshot.rows, among)
  if (items.length === 0) {
    void vscode.window.showInformationMessage(snapshot.rows.length === 0 ? "Flywheel has no chats yet." : "Flywheel has no open chats.")
    return
  }
  const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true })
  if (!picked) return
  await run({ id: picked.id, title: picked.label })
}
