/**
 * Shared fixtures for model-listing tests.
 */

import type { AuthContext } from "../../../../src/infra/auth/auth-context.js";
import { authDir } from "../../../../src/infra/paths.js";
import { testDirectories } from "../../../helpers/directories.js";
import { authProviders } from "../../../helpers/auth-context.js";

/** Credential directory under this test process's isolated account home, so a
 *  listing client reads only what the test installed. */
export const AUTH_DIR = authDir(testDirectories(process.cwd()).userDataRoot, "default");

export const AUTH_ALL: AuthContext = {
  providers: authProviders({ apiKeys: { anthropic_api: "sk-ant-test", openai_api: "sk-openai-test", google_api: "google-test-key" } }),
  credentialLineages: {
    anthropic_api: "00000000-0000-4000-8000-000000000001",
    openai_api: "00000000-0000-4000-8000-000000000002",
    google_api: "00000000-0000-4000-8000-000000000003",
  },
  droppedCredentials: [],
};

export const AUTH_NONE: AuthContext = {
  providers: authProviders(),
  credentialLineages: {},
  droppedCredentials: [],
};

