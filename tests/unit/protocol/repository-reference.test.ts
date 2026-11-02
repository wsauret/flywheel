import { describe, expect, test } from "bun:test"

import { parseRepository } from "../../../src/protocol/repository-reference.js"

/** What a person may type to name a repository on a phone or a terminal, and
 *  what the machine clones from it. A device never names a path on the
 *  machine (PI-REMOTE-009), so everything that is not an https or ssh
 *  repository is refused before anything runs. */

describe("naming a repository to clone", () => {
  test.each([
    ["owner/repo", "https://github.com/owner/repo.git", "repo"],
    ["  owner/repo.git ", "https://github.com/owner/repo.git", "repo"],
    ["https://github.com/owner/repo", "https://github.com/owner/repo", "repo"],
    ["https://gitlab.example.com/group/sub/repo.git/", "https://gitlab.example.com/group/sub/repo.git/", "repo"],
    ["ssh://git@host.example:2222/team/tool.git", "ssh://git@host.example:2222/team/tool.git", "tool"],
    ["git@github.com:owner/repo.git", "git@github.com:owner/repo.git", "repo"],
  ])("reads %p as a clone of %p into a folder named %p", (typed, url, name) => {
    expect(parseRepository(typed)).toEqual({ url, name })
  })

  test.each([
    ["", "Name a repository"],
    ["/home/person/secret", "Name a repository as owner/repo"],
    ["../elsewhere", "Name a repository as owner/repo"],
    ["C:\\Users\\person\\repo", "only over https or ssh"],
    ["file:///home/person/repo", "only over https or ssh"],
    ["http://example.com/repo.git", "only over https or ssh"],
    ["ext::sh -c touch% /scratch/pwned", "not a repository name or URL"],
    ["https://person:token@github.com/owner/repo.git", "Leave the user name, token, and password out"],
    ["https://ghp_token@github.com/owner/repo.git", "Leave the user name, token, and password out"],
    ["https://github.com/", "names no repository"],
    ["owner/..", "not a repository name or URL"],
  ])("refuses %p", (typed, message) => {
    expect(() => parseRepository(typed)).toThrow(message)
  })
})
