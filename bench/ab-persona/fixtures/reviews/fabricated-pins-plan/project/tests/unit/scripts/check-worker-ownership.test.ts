import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  findWorkerOwnershipViolations,
  type WorkerOwnershipViolation,
} from "../../../scripts/check-worker-ownership.js"

interface RepoFiles {
  readonly [file: string]: string
}

async function withRepo(files: RepoFiles): Promise<WorkerOwnershipViolation[]> {
  const root = mkdtempSync("/tmp/flywheel-worker-ownership-")
  try {
    for (const [file, content] of Object.entries(files)) {
      const path = join(root, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    return await findWorkerOwnershipViolations(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function rules(violations: readonly WorkerOwnershipViolation[]): string[] {
  return violations.map(({ file, line, rule }) => `${file}:${line} ${rule}`)
}

describe("check-worker-ownership", () => {
  test("rejects raw Worker construction outside exact authority sites", async () => {
    const violations = await withRepo({
      "src/infra/bounded-worker-spawner.ts": [
        "function createBoundedWorkerSpawner() {",
        "  new globalThis.Worker(url)",
        "}",
        "function createEmbeddedWorkerSpawner() { new Worker(url) }",
        "export const worker = new Worker(url)",
      ].join("\n"),
      "src/orchestration/domain.ts": [
        "export function run() {",
        "  const direct = new Worker(url)",
        "  const qualified = new globalThis.Worker(url)",
        "}",
      ].join("\n"),
      "scripts/release-worker.ts": "export const worker = new Worker(url)\n",
    })

    expect(rules(violations)).toEqual([
      "scripts/release-worker.ts:1 no-raw-worker",
      "src/infra/bounded-worker-spawner.ts:5 no-raw-worker",
      "src/orchestration/domain.ts:2 no-raw-worker",
      "src/orchestration/domain.ts:3 no-raw-worker",
    ])
  })

  test("rejects extra Worker construction inside the authority", async () => {
    const violations = await withRepo({
      "src/infra/bounded-worker-spawner.ts": [
        "function createBoundedWorkerSpawner() {",
        "  new globalThis.Worker(url)",
        "  new globalThis.Worker(url)",
        "}",
        "function createEmbeddedWorkerSpawner() { new Worker(url) }",
      ].join("\n"),
    })

    expect(rules(violations)).toEqual([
      "src/infra/bounded-worker-spawner.ts:3 no-raw-worker",
    ])
  })

  test("rejects a missing Worker authority constructor", async () => {
    const violations = await withRepo({
      "src/infra/bounded-worker-spawner.ts": "function createBoundedWorkerSpawner() { new globalThis.Worker(url) }\n",
    })

    expect(violations.map(({ rule, detail }) => `${rule}:${detail}`)).toEqual([
      "missing-worker-authority:createEmbeddedWorkerSpawner:Worker",
    ])
  })

  test("rejects Worker and MessageChannel constructor aliases", async () => {
    const violations = await withRepo({
      "src/orchestration/domain.ts": [
        "const WorkerCtor = globalThis.Worker",
        "const ChannelCtor = MessageChannel",
        "const { Worker: DestructuredWorker } = globalThis",
        "import { MessageChannel as ImportedChannel } from \"node:worker_threads\"",
        "import * as threads from \"node:worker_threads\"",
        "new WorkerCtor(url)",
        "new ChannelCtor()",
        "new DestructuredWorker(url)",
        "new ImportedChannel()",
        "new threads.Worker(url)",
        "new threads.MessageChannel()",
        "new globalThis[\"Worker\"](url)",
        "Reflect.construct(Worker, [url])",
        "Reflect.construct(MessageChannel, [])",
      ].join("\n"),
    })

    expect(rules(violations)).toEqual([
      "src/orchestration/domain.ts:6 no-raw-worker",
      "src/orchestration/domain.ts:7 unowned-message-channel",
      "src/orchestration/domain.ts:8 no-raw-worker",
      "src/orchestration/domain.ts:9 unowned-message-channel",
      "src/orchestration/domain.ts:10 no-raw-worker",
      "src/orchestration/domain.ts:11 unowned-message-channel",
      "src/orchestration/domain.ts:12 no-raw-worker",
      "src/orchestration/domain.ts:13 no-raw-worker",
      "src/orchestration/domain.ts:14 unowned-message-channel",
    ])
  })

  test("rejects unknown, dynamic, misplaced, and duplicate Worker roles", async () => {
    const violations = await withRepo({
      "src/orchestration/app-service/worker-runtime-client.ts": [
        "function createWorkerRuntimeClient() {",
        "  createBoundedWorkerSpawner(\"runtime-worker\")",
        "  createBoundedWorkerSpawner(\"runtime-worker\")",
        "}",
      ].join("\n"),
      "src/orchestration/domain.ts": [
        "createBoundedWorkerSpawner(\"runtime-background\")",
        "createBoundedWorkerSpawner(\"made-up-worker\")",
        "createBoundedWorkerSpawner(role)",
      ].join("\n"),
    })

    expect(rules(violations)).toEqual([
      "src/orchestration/app-service/worker-runtime-client.ts:3 unapproved-worker-owner",
      "src/orchestration/domain.ts:1 unapproved-worker-owner",
      "src/orchestration/domain.ts:2 unknown-worker-role",
      "src/orchestration/domain.ts:3 unknown-worker-role",
    ])
  })

  test("rejects imported, namespace, and local Worker allocator aliases", async () => {
    const violations = await withRepo({
      "src/orchestration/domain.ts": [
        "import { createBoundedWorkerSpawner as importedAllocate } from '../infra/bounded-worker-spawner.js'",
        "import * as spawners from '../infra/bounded-worker-spawner.js'",
        "const allocate = createBoundedWorkerSpawner",
        "const allocateAgain = allocate",
        "importedAllocate('made-up-worker')",
        "allocateAgain('runtime-background')",
        "spawners.createBoundedWorkerSpawner('runtime-worker')",
        "spawners.embeddedWorkerSpawnerSource('made-up-worker')",
      ].join("\n"),
    })

    expect(rules(violations)).toEqual([
      "src/orchestration/domain.ts:5 unknown-worker-role",
      "src/orchestration/domain.ts:6 unapproved-worker-owner",
      "src/orchestration/domain.ts:7 unapproved-worker-owner",
      "src/orchestration/domain.ts:8 unknown-worker-role",
    ])
  })

  test("permits only the reviewed number of MessageChannels in each owner", async () => {
    const violations = await withRepo({
      "src/orchestration/app-service/worker-runtime-client.ts": [
        "function admitWorker() {",
        "  new MessageChannel()",
        "  new MessageChannel()",
        "  new MessageChannel()",
        "  new MessageChannel()",
        "}",
        "function unrelated() { new MessageChannel() }",
      ].join("\n"),
      "src/orchestration/app-service/runtime-worker-server.ts": [
        "function startMaintenanceWorker() {",
        "  new MessageChannel()",
        "  new MessageChannel()",
        "}",
      ].join("\n"),
      "src/orchestration/domain.ts": "export const channel = new MessageChannel()\n",
    })

    expect(rules(violations)).toEqual([
      "src/orchestration/app-service/runtime-worker-server.ts:3 unowned-message-channel",
      "src/orchestration/app-service/worker-runtime-client.ts:5 unowned-message-channel",
      "src/orchestration/app-service/worker-runtime-client.ts:7 unowned-message-channel",
      "src/orchestration/domain.ts:1 unowned-message-channel",
    ])
  })

  test("the production tree has no unowned native port constructor", async () => {
    expect(await findWorkerOwnershipViolations(join(import.meta.dir, "..", "..", ".."))).toEqual([])
  }, 20_000)
})
