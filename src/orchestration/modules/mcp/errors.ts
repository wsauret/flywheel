// These errors live apart from the connection and OAuth code, which load the MCP SDK. The manager tells a server
// that needs authentication from one that failed before it opens its first connection, and the nested tool reads a
// call's outcome, so neither must load the SDK.

/** The server refused a request because its credentials are missing or no longer accepted. */
export class McpNeedsAuthError extends Error {
  constructor(server: string) {
    super(`MCP server '${server}' needs authentication`);
    this.name = "McpNeedsAuthError";
  }
}

/** A tool call that ended after its request left Flywheel and before the server answered: an
 *  interrupt, a closed connection, a network or gateway failure, or an unreadable response. The
 *  server may have completed the call, so its effect must be checked before the call repeats. */
export class McpOutcomeUnknownError extends Error {
  constructor(readonly reason: string) {
    super(`MCP call ended without the server's answer: ${reason}`);
    this.name = "McpOutcomeUnknownError";
  }
}

/** The stored OAuth credentials cannot be refreshed without the person authorizing the server again. */
export class McpOAuthNeedsAuthError extends Error {
  constructor() {
    super("MCP OAuth requires user authorization");
    this.name = "McpOAuthNeedsAuthError";
  }
}

/** Flywheel's own sign-in failed at client registration: the authorization server has no registration endpoint, or it
 *  refused or failed the registration request. Such a server can accept only approved apps. */
export class McpRegistrationRefusedError extends Error {
  constructor(server: string, options?: ErrorOptions) {
    super(`MCP server '${server}' did not register Flywheel as an OAuth client`, options);
    this.name = "McpRegistrationRefusedError";
  }
}

/** Another sign-in holds the fixed local callback port that a server's OAuth client requires. */
export class McpSignInPortBusyError extends Error {
  constructor(port: number) {
    super(`Another sign-in is using local port ${port}. Finish or cancel it, then try again.`);
    this.name = "McpSignInPortBusyError";
  }
}
