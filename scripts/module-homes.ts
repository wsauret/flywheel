// The one statement of where a module lives, shared by every gate that judges
// locality (ARCH-STRUCTURE-018 homes). A module has
// one id and one home per layer; the registries are the only files that may
// reach into a home from outside it. The orchestration catalog has two
// registries: the credential provider registry, which auth reads alone, and the
// module registry of every other module. The development catalog is the list
// only the source entry installs (ARCH-STRUCTURE-013).

export const MODULE_REGISTRIES: readonly string[] = [
  "src/protocol/modules.ts",
  "src/orchestration/credential-provider-modules.ts",
  "src/orchestration/modules.ts",
  "src/orchestration/development-modules.ts",
  "src/tui/modules.ts",
  "webview/src/modules.ts",
];

/** A path that ends in "/" names a directory; any other path names one file. */
export function isUnderAny(relPath: string, homes: readonly string[]): boolean {
  return homes.some((home) => (home.endsWith("/") ? relPath.startsWith(home) : relPath === home));
}

/** The module's home in each layer. The orchestration home is spelled both as
 *  one descriptor file and as a directory, because a module with one file has
 *  no directory yet. */
export function moduleLayerHomes(id: string) {
  return {
    protocol: [`src/protocol/modules/${id}.ts`, `src/protocol/modules/${id}/`],
    orchestration: [`src/orchestration/modules/${id}.ts`, `src/orchestration/modules/${id}/`],
    tui: [`src/tui/modules/${id}/`],
    web: [`webview/src/modules/${id}/`],
  } as const;
}

export function moduleHomes(id: string): readonly string[] {
  const homes = moduleLayerHomes(id);
  return [...homes.protocol, ...homes.orchestration, ...homes.tui, ...homes.web];
}

/** The canonical owner segment of a path inside a module home. */
export function moduleHomeId(relPath: string): string | undefined {
  const match = relPath.match(/^(?:src\/protocol|src\/orchestration|src\/tui|webview\/src)\/modules\/([^/.]+)(?:\.[jt]sx?|\/)/);
  return match?.[1];
}

/** Where a module's durable fact schemas are defined: its orchestration home,
 *  or `src/workflows/` for the two modules whose facts sit in the layer below
 *  orchestration. */
export function moduleFactHomes(id: string): readonly string[] {
  const orchestration = [`src/orchestration/modules/${id}.ts`, `src/orchestration/modules/${id}/`];
  return id === "workflows" || id === "learning" ? [...orchestration, "src/workflows/"] : orchestration;
}

/** The module whose home holds `relPath`, if any. */
export function moduleHomeOwner(relPath: string, moduleIds: readonly string[]): string | undefined {
  return moduleIds.find((id) => isUnderAny(relPath, moduleHomes(id)));
}

/** The boundary rule: a file outside a module's homes may import from them
 *  only if it is one of the registries. Returns the module whose home the
 *  import crosses into, or undefined when the import is in bounds. */
export function moduleHomeImportViolation(sourcePath: string, targetPath: string, moduleIds: readonly string[]): string | undefined {
  const owner = moduleHomeOwner(targetPath, moduleIds);
  if (owner === undefined) return undefined;
  if (moduleHomeOwner(sourcePath, moduleIds) === owner) return undefined;
  if (MODULE_REGISTRIES.includes(sourcePath)) return undefined;
  // Host adapters and the shared host capability contract compile against
  // published protocol types, never module runtime or rendering code. The
  // phone shell is the relay host's adapter that ships with the client.
  if (targetPath.startsWith("src/protocol/modules/") && (sourcePath === "webview/src/host.ts" || ["relay/", "vscode/", "webview/phone/"].some((root) => sourcePath.startsWith(root)))) return undefined;
  return owner;
}
