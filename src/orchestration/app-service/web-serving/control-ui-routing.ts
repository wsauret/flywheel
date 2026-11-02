import { CLIENT_IDENTITY_PATTERN } from "../../../protocol/client-identity.js"
import { acceptsControlUiHtmlResponse, isReadHttpMethod } from "./control-ui-http-utils"

export type ControlUiRequestClassification =
  | { kind: "not-control-ui" }
  /** `/client/<identity>/<path>`: one file of the client build, named by the
   *  identity of the build it belongs to. `path` is still URL-encoded. */
  | { kind: "client"; identity: string; path: string }
  /** The page, a file at the root, or a page address the client routes. */
  | { kind: "serve"; spaFallback: boolean }

/** Classifies requests for the fixed root Control UI mount. */
export function classifyControlUiRequest(params: {
  pathname: string
  method: string | undefined
  accept?: string | null
}): ControlUiRequestClassification {
  if (!isReadHttpMethod(params.method)) return { kind: "not-control-ui" }
  const [, prefix, identity, ...rest] = params.pathname.split("/")
  if (prefix === "client" && identity !== undefined && CLIENT_IDENTITY_PATTERN.test(identity) && rest.length > 0) {
    return { kind: "client", identity, path: rest.join("/") }
  }
  return { kind: "serve", spaFallback: acceptsControlUiHtmlResponse(params.accept) }
}
