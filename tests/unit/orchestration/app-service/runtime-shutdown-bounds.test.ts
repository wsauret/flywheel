import { expect, test } from "bun:test"
import { PROCESS_KILL_GRACE_MS } from "../../../../src/infra/process-supervisor.js"
import { SERVICE_STOP_TIMEOUT_SECONDS } from "../../../../src/orchestration/app-service/account-service-registration.js"
import { ACCOUNT_DRAIN_HARD_EXIT_MS, PROJECT_EXECUTOR_STOP_DEADLINE_MS, RUNTIME_SHUTDOWN_HANDSHAKE_TIMEOUT_MS } from "../../../../src/orchestration/app-service/runtime-shutdown.js"

/** What the account's drain must still hold after a stop that missed its
 *  deadline was killed: the proof that the kill emptied the container, that
 *  generation's recovery, and the later drain phases. */
const RECOVERY_ALLOWANCE_MS = 10_000

test("the shutdown bounds nest with room after a missed stop, so no owner cuts a shutdown that an inner bound still allows", () => {
  // The executor arms its own hard exit at its stop; the account waits for
  // it with the grace for its answer; a stop that misses that deadline is
  // killed and recovered inside the account's drain; and the service
  // manager's stop timeout holds the drain.
  expect(RUNTIME_SHUTDOWN_HANDSHAKE_TIMEOUT_MS).toBe(35_000)
  expect(PROJECT_EXECUTOR_STOP_DEADLINE_MS).toBe(40_000)
  expect(ACCOUNT_DRAIN_HARD_EXIT_MS).toBe(55_000)
  expect(RUNTIME_SHUTDOWN_HANDSHAKE_TIMEOUT_MS).toBeLessThan(PROJECT_EXECUTOR_STOP_DEADLINE_MS)
  expect(PROJECT_EXECUTOR_STOP_DEADLINE_MS + PROCESS_KILL_GRACE_MS + RECOVERY_ALLOWANCE_MS).toBeLessThanOrEqual(ACCOUNT_DRAIN_HARD_EXIT_MS)
  expect(ACCOUNT_DRAIN_HARD_EXIT_MS).toBeLessThan(SERVICE_STOP_TIMEOUT_SECONDS * 1_000)
})
