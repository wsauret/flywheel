import { onTestFinished } from "bun:test";
import { processLoginObservations, type LoginKey, type LoginObservations } from "../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js";

/**
 * The login observations of the test process, which every bridge, listing, and auth view of the process shares, as in
 * production. When the current test finishes, each login in `logins` is forgotten, so the question, the last request,
 * and the plan that the test leaves for it reach no later test of the process. Call it inside a test.
 */
export function observedLogins(...logins: readonly LoginKey[]): LoginObservations {
  onTestFinished(() => {
    for (const login of logins) processLoginObservations.forget(login);
  });
  return processLoginObservations;
}
