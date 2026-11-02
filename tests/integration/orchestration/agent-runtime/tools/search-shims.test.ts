import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { shellSearchStoppedMessage } from "../../../../../src/orchestration/agent-runtime/tools/search-rules.js";
import { makeContext } from "../../../../unit/orchestration/agent-runtime/tools/_fixtures.js";

// The search rules of the agent shell (ARCH-TOOLS-052, PI-AGENT-053), through
// the real bash tool, its PATH, and the person's own search programs.
// Each case runs several shell commands, which a loaded machine slows well past the default limit.
setDefaultTimeout(60_000);

describe.skipIf(process.platform === "win32")("bash tool: search shims", () => {
  // Bun runs the body of a skipped describe but none of its hooks, so the
  // folder is created in beforeAll: a skipped run creates nothing to leak.
  let root: string;
  let project: string;
  let scratchDir: string;
  const bash = createBashDefinition({ loginShellPath: () => undefined });

  async function run(command: string, timeout?: number): Promise<string> {
    const result = await bash.execute({ command, raw_output: true, ...(timeout ? { timeout } : {}) }, makeContext({ executionCwd: project, scratchDir }));
    expect(result.outcome).toBe("ok");
    if (typeof result.content !== "string") throw new Error("bash returned content that is not text");
    return result.content;
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "search-shims-"));
    // An ancestor named like a pruned directory never turns pruning off.
    project = path.join(root, ".cache", "project");
    scratchDir = path.join(root, "scratch");
    await loadBashParser();
    const files = {
      ".gitignore": "ignored-dir/\n.env\ncache[[]x]/\nback\\\\slash/\n",
      "back\\slash/b.txt": "needle\n",
      "bench/README": "tracked\n",
      "cache[x]/c.txt": "needle\n",
      "cachex/c.txt": "needle\n",
      "limit.sh": "#!/bin/sh\nulimit -t\n",
      "../other/.gitignore": "other-ignored/\n",
      "../other/other-ignored/o.txt": "needle\n",
      "../other/ignored-dir/k.txt": "needle\n",
      "src/a.txt": "needle\n",
      "src/build": "needle\n",
      ".env": "needle\n",
      "ignored-dir/i.txt": "needle\n",
      "node_modules/pkg/n.txt": "needle node_modules\n",
      "vendor/lib/v.txt": "needle\n",
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      fs.writeFileSync(path.join(project, file), text);
    }
    fs.chmodSync(path.join(project, "limit.sh"), 0o755);
    const commit = "git -c user.email=t@t -c user.name=t commit -qm init";
    await run(`git init -q . && git add .gitignore bench cachex src && ${commit} && cd ../other && git init -q . && git add . && ${commit}`);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("puts the shims of the present programs first on PATH, each running the real program", async () => {
    const output = await run("command -v grep find du");
    const shims = path.join(scratchDir, "search-shims");
    for (const program of ["grep", "find", "du"]) expect(output).toMatch(new RegExp(`${shims}/[0-9a-f]+/${program}\\n`));
    expect(output).toContain("[exit code: 0]");
  });

  it("passes pipes, stdin, caller descriptors, and exit codes through unchanged", async () => {
    const output = await run("printf 'a\\nneedle\\n' | grep needle; printf 'a\\n' | grep needle; echo no-match=$?; grep needle missing-file; echo error=$?; yes | grep y | head -1; printf 'src/a.txt\\n' | xargs grep -l needle; grep -c needle /dev/fd/3 3<src/a.txt; grep -c needle /dev/fd/3 3<src/a.txt 4<src/a.txt 5<src/a.txt 6<src/a.txt 7<src/a.txt 8<src/a.txt 9<src/a.txt");
    expect(output).toContain("needle\nno-match=1\n");
    expect(output).toMatch(/error=2\ny\nsrc\/a\.txt\n1\n1\n/);
  });

  it("prunes artifact and ignored directories from recursive grep and find, keeping ignored files and named directories", async () => {
    const output = await run([
      "echo grep:; grep -rl needle . | sort",
      "echo pattern:; grep -rl node_modules .",
      "echo named:; grep -rl needle node_modules ignored-dir",
      "echo find:; find . -maxdepth 3 -name '*.txt' | sort",
      "echo find-named:; find node_modules -name '*.txt'",
      "echo find-test:; find . -path '*/vendor/*' -type f",
      "echo absolute:; find \"$PWD\" -name '*.txt' | sed \"s|^$PWD/||\" | sort",
      // Another repository's own ignore rules decide what its search skips.
      "echo other:; grep -rl needle ../other",
      // A name that any root ignores is pruned below every root, unless a root tracks a directory of that name.
      "echo both:; grep -rl needle ../other . | sort",
      "echo dashdash:; find -- . -name a.txt",
    ].join("; "));
    // `cache[x]` is ignored and `cachex` is tracked, so glob characters in a name match literally.
    expect(output).toContain("grep:\n./.env\n./cachex/c.txt\n./src/a.txt\n./src/build\npattern:\nnamed:\nnode_modules/pkg/n.txt\nignored-dir/i.txt\n");
    // Global options keep working ahead of the inserted prune clause, without a warning.
    expect(output).toContain("find:\n./cachex/c.txt\n./src/a.txt\nfind-named:\nnode_modules/pkg/n.txt\nfind-test:\n./vendor/lib/v.txt\nabsolute:\ncachex/c.txt\nsrc/a.txt\nother:\n../other/ignored-dir/k.txt\nboth:\n../other/ignored-dir/k.txt\n./.env\n./cachex/c.txt\n./ignored-dir/i.txt\n./src/a.txt\n./src/build\ndashdash:\n./src/a.txt\n");
  });

  it.skipIf(process.platform !== "darwin")("keeps a root that BSD find takes through -f", async () => {
    expect(await run("find -f node_modules -name '*.txt'")).toContain("node_modules/pkg/n.txt\n");
  });

  it("reads grep's option values and recursion forms the way grep does", async () => {
    const output = await run([
      "echo attached:; grep -rl -eneedle vendor",
      "echo cluster:; grep -rleneedle ignored-dir",
      "echo d-recurse:; grep -d recurse -l needle . | sort",
    ].join("; "));
    expect(output).toContain("attached:\nvendor/lib/v.txt\ncluster:\nignored-dir/i.txt\nd-recurse:\n./.env\n./cachex/c.txt\n./src/a.txt\n./src/build\n");
  });

  it("filters pruned directories out of depth-first find output and leaves operands and -exec commands in place", async () => {
    const output = await run([
      "touch node_modules/pkg/kept.tmp src/gone.tmp",
      "echo depth:; find . -depth -type f -name '*.tmp' | sort",
      "find . -name '*.tmp' -delete; echo delete:; ls node_modules/pkg/kept.tmp src/gone.tmp 2>/dev/null",
      "echo operand:; find src -name -depth",
      "echo exec:; find src -name a.txt -exec echo -depth {} ';'",
    ].join("; "));
    expect(output).toContain("depth:\n./src/gone.tmp\ndelete:\nnode_modules/pkg/kept.tmp\noperand:\nexec:\n-depth src/a.txt\n[exit code: 0");
  });

  it("runs find -exec without the limit and keeps du unpruned", async () => {
    const output = await run("find src -maxdepth 0 -exec sh -c 'ulimit -t' \\;; du -sk node_modules | cut -f1; command -p du -sk node_modules | cut -f1");
    const [limit, shimmed, real] = output.split("\n");
    expect(limit).toBe("unlimited");
    expect(shimmed).toBe(real ?? "");
  });

  it.skipIf(Bun.which("rg") === null)("adds the pruned names to rg, also without its ignore rules, and keeps a named directory reachable", async () => {
    const output = await run("echo all:; rg -l needle | sort; echo unrestricted:; rg -uu -l 'needle|vendor' . | sort; echo named:; rg -l needle vendor; echo include-all:; rg -uu -l -g '**' needle . | sort; echo dashdash:; rg -l -g '**' -- needle . | sort");
    // A file named like a pruned directory stays searchable, and a search pattern never names a directory.
    // A broad include glob, also before `--`, never undoes the exclusions; it only makes rg read ignored files.
    expect(output).toContain("all:\ncachex/c.txt\nsrc/a.txt\nsrc/build\nunrestricted:\n./.env\n./cachex/c.txt\n./src/a.txt\n./src/build\nnamed:\nvendor/lib/v.txt\ninclude-all:\n./.env\n./cachex/c.txt\n./src/a.txt\n./src/build\ndashdash:\n./.env\n./cachex/c.txt\n./src/a.txt\n./src/build\n");
  });

  it.skipIf(Bun.which("fd") === null)("prunes ignored directories from fd without its ignore rules and runs every exec spelling without the limit", async () => {
    const output = await run("echo all:; fd -u -e txt | sort; echo exec:; fd a.txt src -x sh -c 'ulimit -t'; fd -x./limit.sh a.txt src; fd --exec=./limit.sh a.txt src; fd a.txt src -HX sh -c 'ulimit -t'");
    expect(output).toContain("all:\ncachex/c.txt\nsrc/a.txt\nexec:\nunlimited\nunlimited\nunlimited\nunlimited\n");
  });

  it("stops a search after the processing-time limit but never a filter that waits on its input", async () => {
    const search = "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | grep -E '(a|aa)*b'";
    const [stopped, crowded, waited] = await Promise.all([
      run(`${search}; echo status=$?`, 300),
      // With every spare descriptor held by the caller, the shell's own report may show too.
      run(`${search} 3<src/a.txt 4<src/a.txt 5<src/a.txt 6<src/a.txt 7<src/a.txt 8<src/a.txt 9<src/a.txt; echo status=$?`, 300),
      run("(sleep 35; echo done) | grep done; echo status=$?", 300),
    ]);
    expect(stopped).toContain(`${shellSearchStoppedMessage("grep")}\nstatus=2\n`);
    expect(crowded).toContain(`${shellSearchStoppedMessage("grep")}\nstatus=2\n`);
    expect(waited).toContain("done\nstatus=0\n");
  }, 300_000);
});
