import { Redacted } from "effect"
import type { AuthContext } from "../../src/infra/auth/auth-context.js"
import { FIXTURE_EXECUTION_CWD, testDirectories } from "../helpers/directories.js"
import { authProviders } from "../helpers/auth-context.js"

export const testAuth: AuthContext = {
  providers: authProviders({ apiKeys: { openai_api: "test-openai-key" } }),
  credentialLineages: {}, droppedCredentials: [],
}

const directories = testDirectories(FIXTURE_EXECUTION_CWD)

/** Directory authorities a title generator receives. The title runner carries
 *  no tools, so the project realm only has to exist; the account roots are the
 *  isolated ones this test process owns. */
export const titleRoots = {
  projectRoot: directories.projectRoot,
  userDataRoot: directories.userDataRoot,
  accountHome: directories.accountHome,
}
