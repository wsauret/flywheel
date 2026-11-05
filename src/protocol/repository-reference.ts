/** A repository a person names for a machine to clone into a new project
 *  (PI-REMOTE-021): what a device checks before it asks, and what the account
 *  service checks again before it runs git. Bun-free and DOM-free. */

/** A repository a device named, as the machine clones it. */
export interface RepositoryReference {
  /** What `git clone` reads: an https or ssh URL. */
  readonly url: string
  /** The repository's own name, which the machine's folder starts from. */
  readonly name: string
}

const MAX_REFERENCE_LENGTH = 2_048
const GITHUB_SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/
const SCP_LIKE = /^[A-Za-z0-9._-]+@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):([^:\\].*)$/

/** Reads what a person typed as a repository: `owner/repo` on GitHub, an
 *  https URL, an ssh URL, or `user@host:path`. Anything else, a path on the
 *  machine or a `file:` URL among them, is refused, because a device never
 *  names a path on the machine. An https URL that carries a user name or a
 *  token, and any URL that carries a password, is refused too: git would keep
 *  it in the clone's configuration, and the machine's own git credentials are
 *  the only ones a clone uses. An ssh URL keeps its user name, such as `git@`,
 *  because ssh needs it and it is no secret. Throws with a message a person
 *  can act on. */
export function parseRepository(text: string): RepositoryReference {
  const reference = text.trim()
  if (reference.length === 0) throw new Error("Name a repository to clone, such as owner/repo or its URL.")
  if (reference.length > MAX_REFERENCE_LENGTH || /\s/.test(reference)) throw new Error("That is not a repository name or URL.")
  const shorthand = GITHUB_SHORTHAND.exec(reference)
  if (shorthand) {
    const [, owner, repository] = shorthand
    const name = stripGitSuffix(repository ?? "")
    if (owner === undefined || !usableName(name)) throw new Error("That is not a repository name or URL.")
    return { url: `https://github.com/${owner}/${name}.git`, name }
  }
  const scp = SCP_LIKE.exec(reference)
  if (scp) return { url: reference, name: nameFromPath(scp[2] ?? "") }
  let url: URL
  try {
    url = new URL(reference)
  } catch {
    throw new Error("Name a repository as owner/repo, an https or ssh URL, or user@host:path.")
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") throw new Error("Flywheel clones only over https or ssh.")
  if (url.hostname === "") throw new Error("That repository URL names no host.")
  if (url.password !== "" || (url.protocol === "https:" && url.username !== "")) throw new Error("Leave the user name, token, and password out of the URL. The machine clones with its own git credentials.")
  return { url: reference, name: nameFromPath(url.pathname) }
}

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -".git".length) : name
}

function usableName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".."
}

function nameFromPath(path: string): string {
  const segment = path.split("/").filter((part) => part.length > 0).at(-1) ?? ""
  const name = stripGitSuffix(segment)
  if (!usableName(name)) throw new Error("That repository URL names no repository.")
  return name
}
