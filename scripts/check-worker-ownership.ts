import * as fs from "node:fs"
import * as path from "node:path"
import type { Node, Tree } from "web-tree-sitter"
import { WORKER_GENERATION_BUDGETS } from "../src/infra/bounded-worker-spawner.js"
import { loadTreeSitterParser } from "../src/infra/tree-sitter-parser.js"

type ConstructorKind = "Worker" | "MessageChannel"
type SpawnerFactory = "createBoundedWorkerSpawner" | "embeddedWorkerSpawnerSource"

export interface WorkerOwnershipViolation {
  readonly file: string
  readonly line: number
  readonly rule: "no-raw-worker" | "missing-worker-authority" | "unknown-worker-role" | "unapproved-worker-owner" | "unowned-message-channel"
  readonly detail: string
}

interface ApprovedSpawnerSite {
  readonly role: string
  readonly file: string
  readonly owner: string | undefined
  readonly factory: SpawnerFactory
}

interface ApprovedWorkerConstructorSite {
  readonly file: string
  readonly owner: string
  readonly constructor: string
}

interface InspectionState {
  readonly workerConstructorCounts: Map<string, number>
  readonly spawnerCounts: Map<string, number>
  readonly messageChannelCounts: Map<string, number>
}

interface InspectionSymbols {
  readonly constructors: Map<string, ConstructorKind>
  readonly constructorNamespaces: Set<string>
  readonly spawners: Map<string, SpawnerFactory>
  readonly spawnerNamespaces: Set<string>
}

const WORKER_AUTHORITY = "src/infra/bounded-worker-spawner.ts"
const EXECUTABLE_SOURCE = /\.[mc]?[jt]sx?$/
const DECLARATION_SOURCE = /\.d\.[mc]?ts$/
// Every recognized alias starts with one of these names in the same file.
// Unicode, hex, octal, identity, and continued-line escapes can spell a name.
// Only control, quote, and backslash escapes cannot encode part of these names.
const WORKER_SOURCE_CANDIDATE = /Worker|MessageChannel|\\(?:[^nrtbfv0\\/'"]|0[0-9])/
const KNOWN_ROLES = new Set<string>(Object.keys(WORKER_GENERATION_BUDGETS))
const APPROVED_SPAWNER_SITES = [
  { role: "process-watchdog", file: "src/infra/process-watchdog.ts", owner: undefined, factory: "createBoundedWorkerSpawner" },
  { role: "hard-exit-clock", file: "src/infra/process-watchdog.ts", owner: "createWorker", factory: "embeddedWorkerSpawnerSource" },
  { role: "hard-exit-clock", file: "src/infra/hard-exit-clock.ts", owner: undefined, factory: "createBoundedWorkerSpawner" },
  { role: "streaming-edit-validation", file: "src/orchestration/agent-runtime/tools/streaming-edit-validation.ts", owner: "createStreamingEditValidationService", factory: "createBoundedWorkerSpawner" },
  { role: "bash-private-copy", file: "src/orchestration/agent-runtime/tools/bash-private-copy-jobs.ts", owner: "runPrivateCopyJob", factory: "createBoundedWorkerSpawner" },
  { role: "models-document", file: "src/infra/llm/models-document-job.ts", owner: "runModelsDocumentJob", factory: "createBoundedWorkerSpawner" },
  { role: "code-mode-invocation", file: "src/orchestration/modules/code-mode/worker-pool.ts", owner: "spawnInvocationWorker", factory: "createBoundedWorkerSpawner" },
  { role: "runtime-maintenance", file: "src/orchestration/app-service/runtime-maintenance-owner.ts", owner: "runMaintenanceWorkerJob", factory: "createBoundedWorkerSpawner" },
  { role: "runtime-background", file: "src/orchestration/app-service/worker-background-client.ts", owner: "createProcessBackgroundClient", factory: "createBoundedWorkerSpawner" },
  { role: "project-state", file: "src/orchestration/app-service/project-state-worker-spawner.ts", owner: "spawnProjectStateWorker", factory: "createBoundedWorkerSpawner" },
  { role: "project-state-standby", file: "src/orchestration/app-service/project-state-standby.ts", owner: "startProjectStateStandby", factory: "createBoundedWorkerSpawner" },
  { role: "update-installer", file: "src/orchestration/update/update-worker-installer.ts", owner: "runUpdateWorkerJob", factory: "createBoundedWorkerSpawner" },
] satisfies readonly ApprovedSpawnerSite[]
const APPROVED_WORKER_CONSTRUCTOR_SITES = [
  { file: WORKER_AUTHORITY, owner: "createBoundedWorkerSpawner", constructor: "globalThis.Worker" },
  { file: WORKER_AUTHORITY, owner: "createEmbeddedWorkerSpawner", constructor: "Worker" },
] satisfies readonly ApprovedWorkerConstructorSite[]

export async function findWorkerOwnershipViolations(repoRoot: string): Promise<WorkerOwnershipViolation[]> {
  const violations: WorkerOwnershipViolation[] = []
  const state: InspectionState = { workerConstructorCounts: new Map(), spawnerCounts: new Map(), messageChannelCounts: new Map() }
  for (const absoluteFile of productionFiles(repoRoot)) {
    const file = path.relative(repoRoot, absoluteFile).replaceAll(path.sep, "/")
    const text = fs.readFileSync(absoluteFile, "utf8")
    if (!WORKER_SOURCE_CANDIDATE.test(text)) continue
    const parser = await loadTreeSitterParser(file.endsWith(".tsx") ? "tsx" : "typescript")
    const tree: Tree | null = parser.parse(text)
    if (!tree) throw new Error(`worker-ownership: failed to parse ${file}`)
    try {
      inspectFile(violations, state, file, tree.rootNode)
    } finally {
      tree.delete()
    }
  }
  if (fs.existsSync(path.join(repoRoot, WORKER_AUTHORITY))) {
    for (const site of APPROVED_WORKER_CONSTRUCTOR_SITES) {
      if (state.workerConstructorCounts.has(workerConstructorKey(site.file, site.owner, site.constructor))) continue
      violations.push({ file: site.file, line: 1, rule: "missing-worker-authority", detail: `${site.owner}:${site.constructor}` })
    }
  }
  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule)
  )
}

function productionFiles(repoRoot: string): string[] {
  const files: string[] = []
  for (const relativeRoot of ["src", "scripts"]) {
    const root = path.join(repoRoot, relativeRoot)
    if (fs.existsSync(root)) collectFiles(root, files)
  }
  return files.sort()
}

function collectFiles(directory: string, files: string[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      collectFiles(absolute, files)
      continue
    }
    if (entry.isFile() && EXECUTABLE_SOURCE.test(entry.name) && !DECLARATION_SOURCE.test(entry.name)) files.push(absolute)
  }
}

function inspectFile(violations: WorkerOwnershipViolation[], state: InspectionState, file: string, root: Node): void {
  const symbols = inspectionSymbols(root)
  visit(root, (node) => {
    if (node.type === "new_expression") inspectConstructor(violations, state, symbols, file, node)
    if (node.type !== "call_expression") return
    const reflected = reflectedConstructorKind(node, symbols)
    if (reflected) inspectConstructorUse(violations, state, file, node, reflected, `Reflect.construct(${reflected})`)
    else inspectSpawnerRole(violations, state, symbols, file, node)
  })
}

function inspectConstructor(
  violations: WorkerOwnershipViolation[],
  state: InspectionState,
  symbols: InspectionSymbols,
  file: string,
  node: Node,
): void {
  const constructor = node.childForFieldName("constructor")
  const kind = constructorKind(constructor, symbols)
  if (kind) inspectConstructorUse(violations, state, file, node, kind, constructor?.text ?? kind)
}

function inspectConstructorUse(
  violations: WorkerOwnershipViolation[],
  state: InspectionState,
  file: string,
  node: Node,
  kind: ConstructorKind,
  constructor: string,
): void {
  const owner = enclosingFunctionName(node)
  if (kind === "Worker") {
    const key = workerConstructorKey(file, owner, constructor)
    const count = (state.workerConstructorCounts.get(key) ?? 0) + 1
    state.workerConstructorCounts.set(key, count)
    const approved = APPROVED_WORKER_CONSTRUCTOR_SITES.some((site) =>
      site.file === file && site.owner === owner && site.constructor === constructor
    )
    if (approved && count === 1) return
    violations.push({ file, line: lineOf(node), rule: "no-raw-worker", detail: constructor })
    return
  }
  const maximum = messageChannelMaximum(file, owner, constructor)
  const key = `${file}:${owner ?? "<module>"}`
  const count = (state.messageChannelCounts.get(key) ?? 0) + 1
  state.messageChannelCounts.set(key, count)
  if (maximum !== undefined && count <= maximum) return
  violations.push({ file, line: lineOf(node), rule: "unowned-message-channel", detail: owner ?? "module scope" })
}

function workerConstructorKey(file: string, owner: string | undefined, constructor: string): string {
  return `${file}:${owner ?? "<module>"}:${constructor}`
}

function messageChannelMaximum(file: string, owner: string | undefined, constructor: string): number | undefined {
  if (constructor !== "MessageChannel") return undefined
  if (file === "src/orchestration/app-service/runtime-maintenance-owner.ts" && owner === "runMaintenanceWorkerJob") return 2
  if (file === "src/orchestration/app-service/project-state-worker-spawner.ts" && owner === "spawnProjectStateWorker") return 2
  if (file === "src/orchestration/update/update-worker-installer.ts" && owner === "runUpdateWorkerJob") return 1
  return undefined
}

function inspectSpawnerRole(violations: WorkerOwnershipViolation[], state: InspectionState, symbols: InspectionSymbols, file: string, node: Node): void {
  const functionNode = node.childForFieldName("function")
  const factory = spawnerFactory(functionNode, symbols)
  if (!factory) return
  const argument = node.childForFieldName("arguments")?.namedChildren[0]
  const role = stringValue(argument)
  if (!role || !KNOWN_ROLES.has(role)) {
    violations.push({ file, line: lineOf(node), rule: "unknown-worker-role", detail: argument?.text ?? "missing role" })
    return
  }
  const owner = enclosingFunctionName(node)
  const directFactoryCall = functionNode?.type === "identifier" && functionNode.text === factory
  const site = APPROVED_SPAWNER_SITES.find((candidate) =>
    candidate.role === role && candidate.file === file && candidate.owner === owner && candidate.factory === factory
  )
  const key = `${factory}:${role}:${file}:${owner ?? "<module>"}`
  const count = (state.spawnerCounts.get(key) ?? 0) + 1
  state.spawnerCounts.set(key, count)
  if (site && directFactoryCall && count === 1) return
  violations.push({ file, line: lineOf(node), rule: "unapproved-worker-owner", detail: key })
}

function inspectionSymbols(root: Node): InspectionSymbols {
  const symbols: InspectionSymbols = {
    constructors: new Map<string, ConstructorKind>([["Worker", "Worker"], ["MessageChannel", "MessageChannel"]]),
    constructorNamespaces: new Set(),
    spawners: new Map<string, SpawnerFactory>([["createBoundedWorkerSpawner", "createBoundedWorkerSpawner"], ["embeddedWorkerSpawnerSource", "embeddedWorkerSpawnerSource"]]),
    spawnerNamespaces: new Set(),
  }
  let changed: boolean
  do {
    changed = collectSymbolAliasPass(root, symbols)
  } while (changed)
  return symbols
}

function collectSymbolAliasPass(root: Node, symbols: InspectionSymbols): boolean {
  let changed = false
  visit(root, (node) => {
    if (node.type === "import_statement") {
      if (isWorkerThreadsImport(node)) {
        const namespace = namespaceImportName(node)
        if (namespace && !symbols.constructorNamespaces.has(namespace)) {
          symbols.constructorNamespaces.add(namespace)
          changed = true
        }
        for (const specifier of descendantsOfType(node, "import_specifier")) {
          const imported = specifier.childForFieldName("name")?.text
          const local = specifier.childForFieldName("alias")?.text ?? imported
          if (local && (imported === "Worker" || imported === "MessageChannel") && symbols.constructors.get(local) !== imported) {
            symbols.constructors.set(local, imported)
            changed = true
          }
        }
      }
      if (isWorkerSpawnerImport(node)) {
        const namespace = namespaceImportName(node)
        if (namespace && !symbols.spawnerNamespaces.has(namespace)) {
          symbols.spawnerNamespaces.add(namespace)
          changed = true
        }
        for (const specifier of descendantsOfType(node, "import_specifier")) {
          const imported = specifier.childForFieldName("name")?.text
          const local = specifier.childForFieldName("alias")?.text ?? imported
          if (local && (imported === "createBoundedWorkerSpawner" || imported === "embeddedWorkerSpawnerSource") && symbols.spawners.get(local) !== imported) {
            symbols.spawners.set(local, imported)
            changed = true
          }
        }
      }
    }
    if (node.type !== "variable_declarator") return
    const name = node.childForFieldName("name")
    const value = node.childForFieldName("value")
    if (!name || !value) return
    if (name.type === "identifier") {
      const constructor = constructorKind(value, symbols)
      if (constructor && symbols.constructors.get(name.text) !== constructor) {
        symbols.constructors.set(name.text, constructor)
        changed = true
      }
      const spawner = spawnerFactory(value, symbols)
      if (spawner && symbols.spawners.get(name.text) !== spawner) {
        symbols.spawners.set(name.text, spawner)
        changed = true
      }
      if (value.type === "identifier" && symbols.constructorNamespaces.has(value.text) && !symbols.constructorNamespaces.has(name.text)) {
        symbols.constructorNamespaces.add(name.text)
        changed = true
      }
      if (value.type === "identifier" && symbols.spawnerNamespaces.has(value.text) && !symbols.spawnerNamespaces.has(name.text)) {
        symbols.spawnerNamespaces.add(name.text)
        changed = true
      }
      return
    }
    if (name.type !== "object_pattern" || value.text !== "globalThis") return
    for (const pair of name.namedChildren) {
      if (!pair || pair.type !== "pair_pattern") continue
      const constructor = pair.childForFieldName("key")?.text
      const local = pair.childForFieldName("value")?.text
      if (local && (constructor === "Worker" || constructor === "MessageChannel") && symbols.constructors.get(local) !== constructor) {
        symbols.constructors.set(local, constructor)
        changed = true
      }
    }
  })
  return changed
}

function isWorkerThreadsImport(node: Node): boolean {
  const source = stringValue(node.childForFieldName("source"))
  return source === "node:worker_threads" || source === "worker_threads"
}

function isWorkerSpawnerImport(node: Node): boolean {
  const source = stringValue(node.childForFieldName("source"))
  return source !== undefined && /(?:^|\/)bounded-worker-spawner\.[cm]?[jt]s$/.test(source)
}

function namespaceImportName(node: Node): string | undefined {
  return descendantsOfType(node, "namespace_import")[0]?.namedChildren[0]?.text
}

function descendantsOfType(node: Node, type: string): Node[] {
  const matches: Node[] = []
  visit(node, (candidate) => { if (candidate.type === type) matches.push(candidate) })
  return matches
}

function constructorKind(node: Node | null, symbols: InspectionSymbols): ConstructorKind | undefined {
  if (!node) return undefined
  if (node.type === "identifier") return symbols.constructors.get(node.text)
  if (node.type === "member_expression") {
    const object = node.childForFieldName("object")?.text
    const property = node.childForFieldName("property")?.text
    if ((object === "globalThis" || (object && symbols.constructorNamespaces.has(object))) && (property === "Worker" || property === "MessageChannel")) return property
    return undefined
  }
  if (node.type !== "subscript_expression" || node.childForFieldName("object")?.text !== "globalThis") return undefined
  const property = stringValue(node.namedChildren[1])
  return property === "Worker" || property === "MessageChannel" ? property : undefined
}

function spawnerFactory(node: Node | null, symbols: InspectionSymbols): SpawnerFactory | undefined {
  if (!node) return undefined
  if (node.type === "identifier") return symbols.spawners.get(node.text)
  if (node.type !== "member_expression") return undefined
  const object = node.childForFieldName("object")?.text
  const property = node.childForFieldName("property")?.text
  if (!object || !symbols.spawnerNamespaces.has(object)) return undefined
  return property === "createBoundedWorkerSpawner" || property === "embeddedWorkerSpawnerSource" ? property : undefined
}

function reflectedConstructorKind(node: Node, symbols: InspectionSymbols): ConstructorKind | undefined {
  if (node.childForFieldName("function")?.text !== "Reflect.construct") return undefined
  return constructorKind(node.childForFieldName("arguments")?.namedChildren[0] ?? null, symbols)
}

function stringValue(node: Node | null | undefined): string | undefined {
  if (!node || node.type !== "string" || node.text.length < 2) return undefined
  return node.text.slice(1, -1)
}

function enclosingFunctionName(node: Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "function_declaration" || current.type === "function_expression" || current.type === "method_definition") {
      return current.childForFieldName("name")?.text
    }
  }
  return undefined
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1
}

function visit(node: Node, inspect: (node: Node) => void): void {
  inspect(node)
  for (const child of node.namedChildren) if (child) visit(child, inspect)
}

if (import.meta.main) {
  const violations = await findWorkerOwnershipViolations(process.cwd())
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.rule}: ${violation.detail}`)
  }
  if (violations.length > 0) process.exit(1)
  console.log("Worker ownership check passed")
}
