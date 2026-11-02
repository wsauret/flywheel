import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { posix } from "node:path";

import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { Log } from "../../../../../src/infra/log.js";
import * as writeRoots from "../../../../../src/orchestration/agent-runtime/tools/bash-write-roots.js";
import { ShellState } from "../../../../../src/orchestration/agent-runtime/tools/bash-write-state.js";
import { interceptBashCommand } from "../../../../../src/orchestration/agent-runtime/tools/bash-command-policy.js";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";

describe("shell write target policy", () => {
  // Bash reads a backslash as an escape, so a bash command names a Windows path with forward slashes, as Git Bash does.
  const base = fileTemporaryDirectory("bash-write-scope-").replaceAll("\\", "/");
  const P = posix.join(base, "project");
  const H = posix.join(base, "home");
  const U = posix.join(H, ".flywheel");
  const S = posix.join(P, ".flywheel", "sessions", "s", "scratch");
  const O = posix.join(base, "outside");
  const W = posix.join(base, "worktree");
  const L = posix.join(P, "link");
  for (const dir of [S, U, posix.join(O, "deep"), posix.join(O, "sub"), posix.join(P, "sub"), W, posix.join(P, ".git", "worktrees", "w")]) mkdirSync(dir, { recursive: true });
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(posix.join(O, "deep"), L, linkType);
  symlinkSync(posix.join(P, "sub"), posix.join(O, "in"), linkType);
  symlinkSync(O, posix.join(P, "hop"), linkType);
  symlinkSync(posix.join(P, "sub"), posix.join(O, "hop"), linkType);
  symlinkSync("link/../hop", posix.join(P, "relsym"), "dir");
  // Windows removes `..` and trailing periods before it follows a link, and it removes a relative
  // link target's `..` before it follows that target; POSIX follows each link first and keeps periods.
  // Each spelling lands inside the project under one order and outside under the other.
  const resolution = process.platform === "win32" ? "windows" : "posix";
  const otherResolution = resolution === "windows" ? "posix" : "windows";
  const bashLinkParents = {
    windows: [`echo x > ${L}/../escaped`, `cd -P ${L}/..; touch physical`],
    posix: [`echo x > ${O}/in/../through-link`, `cd -P ${O}/in/..; touch physical`],
  };
  const powershellLinkParents = {
    windows: [`Set-Content -Path '${P}\\link\\..\\x' -Value x`, "Set-Content -Path 'link\\..\\relative' -Value x", `Set-Content -Path '${O}\\in.\\alias' -Value x`],
    posix: [`Set-Content -Path '${O}\\in\\..\\leak' -Value x`, `Set-Content -Path '${P}\\link.\\leak' -Value x`, `Set-Content -Path '${P}\\relsym\\leak' -Value x`],
  };
  writeFileSync(posix.join(P, ".git", "worktrees", "w", "gitdir"), posix.join(W, ".git"));
  const scope = { projectRoot: realpathSync(P), userDataRoot: realpathSync(U), scratchDir: S, cwd: P, env: { HOME: H, TMPDIR: O, VAR: posix.join(P, "x") } };
  const policy = (command: string) => interceptBashCommand(command, { scope, effectiveBundledSkillIds: new Set(["worktree-lifecycle"]) });
  const allowed = [
    "rm -rf build dist", "rm -rf build/*", "rm -rf ./node_modules/.cache",
    "echo hi > out.txt 2>/dev/null", `make 2>&1 | tee -a ${S}/build.log`,
    `mkdir -p ${S}/x && touch ${S}/x/y`, "rm -rf ~/.flywheel/cache/foo",
    "cp /etc/hosts ./hosts.copy", "mv a.txt b.txt", "echo 'rm -rf /'",
    "cat <<'EOF' > notes.md\nrm -rf /scratch/x\nEOF",
    "ln -s /etc/hosts ./hosts-link", "find . -name '*.pyc' -delete",
    `rm -rf ${W}/build`, "bash -c 'rm -rf build'", "sudo rm -rf build",
    "tar -xzf /scratch/a.tgz -C vendor", `rm ${L}`, "grep -r foo /etc > found.txt",
    `mktemp -p ${S}`, `cd ${O}; cd ${P}; touch y`, `rm -rf "\${VAR:-/scratch}"`,
    "git worktree add ../sibling-wt",
    `A=${S}; touch "$A/x"`, `export A=${S}; touch "\${A}/y"`,
    `(cd ${O}; cat y); touch z`, `env -C ${O} cat y; touch z`,
    `env -C ${S} touch z`, "command -- /bin/rm -rf build",
    "cp -t build /etc/hosts", "install -m 644 /etc/hosts ./hosts",
    "chmod 644 out.txt", "chown user out.txt", "chgrp group out.txt",
    "dd if=/etc/hosts of=out.txt", "truncate -s 0 out.txt",
    "rmdir build", "unlink out.txt", "shred out.txt", "rsync -a /etc/hosts ./",
    "echo hi >/dev/stdout 2>/dev/stderr", "echo hi >/dev/tty", "echo hi >/dev/fd/3",
    `pushd ${S}; touch y; popd; touch z`, "true # rm -rf /",
    `env -S 'touch ${S}/env-split'`, "find . -exec rm {} +",
    `A=${P}; env A=${O} touch "$A/x"`, `A=${P}; A=${O} touch "$A/x"`,
    `env -u VAR rm "\${VAR:-${O}}"`, `mktemp '${S}/x.XXXXXX'`, "ln -s /etc/hosts",
    `cd ${L}/..; touch inside`, `cd ${L}; cd ..; touch inside`,
    `trap 'cd ${O}' EXIT; touch safe`, `trap -- 'touch ${P}/trapped' EXIT`,
    `command "touch" '${P}/quoted'`, `env -uFOO touch '${P}/compact'`,
    `TARGET="${P}/one ${P}/two"; touch $TARGET`,
    `pushd ${O}; pushd ${P}; pushd; popd; touch inside`,
    `if true; then cd ${P}; else cd ${P}; fi; touch same`,
    "cd -- -dir; touch x",
    `cd ${O}; if true; then cd ${P}; elif false; then cd ${P}; else cd ${P}; fi; touch same`,
    `TARGET="${O}/source ${P}/destination"; cp $TARGET`,
    `A=; touch "\${A:-${P}/fallback}"`,
    `if true; then trap 'touch relative' EXIT; else cd ${O}; fi`,
    "mkdir -p created-sub && cd created-sub && touch y",
    "for f in a.txt b.txt; do rm \"$f\"; done",
    "pushd +0",
    `cd "$UNKNOWN"; touch ${P}/literal`,
    `PWD=${O}; cd ${P}; touch "$PWD/reset"`,
    `TARGET=${P}; TARGET=${O} cd "$TARGET"; touch x`,
    `TARGET=${P}/a; unset -f TARGET; touch "$TARGET"`,
    `TARGET=${O}/a; unset TARGET; touch "\${TARGET:-${P}/fallback}"`,
    `DEST=${O}/x; trap 'touch "$DEST"' EXIT; DEST=${P}/inside`,
    `DEST=${P}/inside; trap 'touch "$DEST"' EXIT; trap - EXIT; DEST=${O}/x`,
    `trap 'touch relative' EXIT; (cd ${O})`,
    `CDPATH=${O}; cd ./sub; touch x`,
    `cat <<'EOF' > ${P}/heredoc\n$(touch ${O}/x)\nEOF`,
    `tar -xf a.tar -C ${O} -C ${P}`,
    `tar -xC ${P} -f a.tar`,
    `tar xzf a.tgz --directory=${P}`,
    "tar -xf archive.tar > extract.log",
    `ln -s ${O} new-redirect-link > new-redirect-link`,
    `TARGET=${P}/a; read -p TARGET OTHER <<< data; touch "$TARGET"`,
    `mkdir -p created-parent; cd created-parent; touch inside`,
    `touch new-file; touch new-file`,
    `${"for f in a; do ".repeat(15)}printf ok${"; done".repeat(15)}`,
    "mkdir -- -", "touch -- -", "tee -- -", "truncate -s 0 -- -",
    ...bashLinkParents[resolution],
  ];
  for (const command of allowed) it(`allows ${command}`, async () => {
    expect(await policy(command)).toBeNull();
  });
  const outside = [
    `rm -rf ${O}/x`, `rm ${O}/x`, `/bin/rm -fr ${O}/x`, `rm -r -f ${O}/x`,
    `rm --force ${O}/x`, `rm ${O}/x -f`, `rm -- ${O}/-x`,
    `sudo rm -rf ${O}/x`, `env TARGET=${O}/x rm -rf ${O}/x`,
    `timeout 5 nice rm -rf ${O}/x`, `busybox rm -rf ${O}/x`,
    `bash -lc 'echo "$(rm -rf ${O}/x)"'`, `trap 'rm -rf ${O}/x' EXIT`, `eval 'rm -rf ${O}/x'`,
    "rm -rf /", "rm -rf ~", 'rm -rf "$HOME"', `rm -rf "\${HOME}/x"`, "rm -rf ..", "rm -rf ../not-a-worktree",
    `echo hi > ${O}/x.txt`, "echo hi >> ~/notes.txt", `make &> ${O}/log`,
    `tee ${O}/log`, `cp a.txt ${O}/`, `cp -t ${O} a.txt`, `mv a.txt ${O}/a.txt`,
    `mv ${O}/a.txt ./a.txt`, `ln -s x ${O}/link`, `touch ${O}/y`, `mkdir -p ${O}/d`,
    `dd if=a of=${O}/b`, "truncate -s 0 ~/f", "sed -i '' s/a/b/ ~/.zshrc", "chmod -R 777 ~",
    `find ${O}/x -delete`, "find ~ -name '*.log' -exec rm {} +", `rsync -a ./ ${O}/bk/`,
    `rsync --remove-source-files ${O}/a ./`, `tar -xf a.tgz -C ${O}/out`,
    `unzip a.zip -d ${O}/out`, "mktemp", "mktemp -d",
    `cd ${O} && rm -rf x`, "cd .. && rm -rf other", `(cd ${O}; touch y)`,
    `echo x > ${L}/file`, `rm -rf ${L}/`, ...bashLinkParents[otherResolution],
    `A=${O}; touch "$A/x"`, `env -u VAR bash -c 'rm "\${VAR:-${O}}"'`,
    `env -C ${O} touch x`, `env -S "rm -rf ${O}/x"`,
    `doas rm ${O}/x`, `command rm ${O}/x`, `builtin eval 'rm ${O}/x'`,
    `exec rm ${O}/x`, `nice -n 5 rm ${O}/x`, `nohup rm ${O}/x`,
    `time -p rm ${O}/x`, `stdbuf -oL rm ${O}/x`, `ionice -c 3 rm ${O}/x`,
    `chrt -i 0 rm ${O}/x`, `setsid rm ${O}/x`, `touch ok || rm ${O}/x`,
    `echo \`rm ${O}/x\``, `if true; then rm ${O}/x; fi`,
    `perl -pi -e 's/a/b/' ${O}/x`, `awk -i inplace '{print}' ${O}/x`,
    `apply_patch <<'PATCH'\n*** Begin Patch\n*** Delete File: ${O}/x\n*** End Patch\nPATCH`,
    `rmdir ${O}/x`, `unlink ${O}/x`, `shred ${O}/x`, `install a ${O}/x`,
    `rm -r ${O}/x`, `mv -t . ${O}/x`, `A=${O}; env A=${P} touch "$A/x"`,
    `A=${O}; A=${P} touch "$A/x"`, `A=$(rm ${O}/x) echo x`,
    `find ${O} -exec sudo rm {} +`, `find ${O} -execdir /bin/rm {} +`,
    `find ${O} -type f -exec true {} \\; -exec rm {} \\;`,
    `command "touch" ${O}/quoted`, `command '--' 'touch' ${O}/quoted-option`,
    `command rm ${O}/verbose -v`,
    `TARGET="${P}/inside ${O}/split"; touch $TARGET`,
    `TARGET="${O}/*"; touch $TARGET`,
    `env -uFOO touch ${O}/compact`, `env -S 'touch\\_${O}/split'`,
    `bash -c 'true' "$(touch ${O}/substitution)"`,
    `env -S 'true' "$(touch ${O}/env-substitution)"`,
    `trap -- 'touch ${O}/trap' EXIT`, `HOME=${O} cd; touch x`,
    `cd ${O}; trap 'cd ${P}' EXIT; touch trapped`,
    `pushd ${O}; pushd ${P}; pushd; touch x`,
    `cd ${P}; cd ${O}; cd -; cd -; touch oldpwd`,
    `PWD=${O}; touch "$PWD/target"`,
    `OLDPWD=${O}; touch "$OLDPWD/target"`,
    `DEST=${P}/inside; trap 'touch "$DEST"' EXIT; DEST=${O}/x`,
    `TARGET=${P}/a; unset TARGET; touch "\${TARGET:-${O}/x}"`,
    `CDPATH=${O}; cd sub; touch x`,
    `cat <<EOF > ${P}/heredoc\n$(touch ${O}/x)\nEOF`,
    `tar -xf a.tar -C ${P} -C ${O}`,
    `tar -xC ${O} -f a.tar`,
    `tar xzf a.tgz -C ${O}`,
    `tar --extract --directory=${O} -f a.tar`,
    `trap 'touch relative' EXIT; cd ${O}`,
    `(trap 'touch ${O}/subshell-trap' EXIT)`,
    `for f in "$(touch ${O}/loop-list)"; do printf ok; done`,
    `while touch ${O}/loop-condition; do printf ok; done`,
    `cd ${O}; mkdir -- -`, `cd ${O}; touch -- -`, `cd ${O}; tee -- -`, `cd ${O}; truncate -s 0 -- -`,
  ];
  for (const command of outside) it(`refuses outside: ${command}`, async () => {
    expect((await policy(command))?.message).toContain("outside");
  });
  const unknown = [
    'rm -rf "$UNSET_VAR"/*', "rm -rf $D/$E", 'rm -rf "$(cat dirs.txt)"',
    'echo x > "$(mktemp)"', "git ls-files -z | xargs -0 rm", 'bash -c "$CMD"',
    "rm -rf build/*/../../..", 'cd "$SOMEWHERE" && rm -rf x',
    "eval \"$CMD\"", "xargs -I{} cp a {}", "rm `cat dirs.txt`",
    `cd ${O}; if false; then cd ${P}; fi; touch conditional`,
    `if false; then A=${P}; elif true; then A=${O}; else A=${P}; fi; touch "$A/x"`,
    `case x in a) cd ${P};; b) cd ${O};; esac; touch conditional`,
    `while false; do cd ${O}; done; touch conditional`,
    `false && cd ${O}; touch conditional`, `true || cd ${O}; touch conditional`,
    `IFS=:; TARGET="${P}/inside:${O}/split"; touch $TARGET`,
    `TARGET="${P}/inside ${O}/split"; IFS=: touch $TARGET`,
    `cd --unknown ${P}; touch x`, `command --unknown touch ${P}/x`,
    `env -S 'touch \${UNKNOWN}'`, `env --unknown touch ${P}/x`,
    `TARGET=${P}/a; read TARGET <<< "${O}/x"; touch "$TARGET"`,
    ...["mapfile TARGET", "readarray TARGET", "getopts a TARGET", "printf -v TARGET '%s' value",
      "read -a TARGET", "printf -vTARGET '%s' value",
      "declare TARGET=$(cat source)", "local TARGET=$(cat source)", "export TARGET=$(cat source)",
      "typeset TARGET=$(cat source)"].map(producer => `TARGET=${P}/a; ${producer}; touch "$TARGET"`),
    `REPLY=${P}/a; read <<< "${O}/x"; touch "$REPLY"`,
    `MAPFILE=${P}/a; mapfile -n 1 <<< "${O}/x"; touch "$MAPFILE"`,
    `DEST=${P}/inside; trap 'touch "$DEST"' USR1; DEST=${O}/x`,
    `CDPATH=$UNKNOWN; cd sub; touch x`,
    `ln -s ${O} ${P}/new-link; touch ${P}/new-link/x`,
    `ln -s ${O} ${P}/new-dir; cd ${P}/new-dir; touch x`,
    `ln -s ${O} ${P}/cdpath-link; CDPATH=${P}/cdpath-link; cd sub; touch x`,
    ...["mv source", "cp source", "install source", "rsync source"].map(writer => `${writer} ${P}/changed; touch ${P}/changed/x`),
    `tar -xf archive -C ${P}/extracted; touch ${P}/extracted/x`,
    `unzip archive -d ${P}/extracted; cd ${P}/extracted; touch x`,
    "touch ./*/../x './*/../x'", "touch './*/../x' ./*/../x",
    `(ln -s ${O} ${P}/subshell-link); touch ${P}/subshell-link/x`,
    `bash -c 'ln -s ${O} ${P}/shell-link'; touch ${P}/shell-link/x`,
    `A=$(ln -s ${O} ${P}/prefix-link) touch ${P}/prefix-link/x`,
    `cat <<EOF > ${P}/heredoc-link/x\n$(ln -s ${O} ${P}/heredoc-link)\nEOF`,
    `DEST=${P}/safe; trap 'touch "$DEST"' USR1; if true; then DEST=${O}/x; kill -USR1 $$; trap - USR1; else DEST=${P}/safe; trap - USR1; fi`,
  ];
  for (const command of unknown) it(`refuses unplaceable: ${command}`, async () => {
    expect((await policy(command))?.message).toContain("cannot tell");
  });
  it("does not admit the per-call cwd as a root", async () => {
    expect((await interceptBashCommand("touch x", { scope: { ...scope, cwd: O } }))?.message).toContain("outside");
    expect((await interceptBashCommand(`cd ${P}/missing; touch x`, { scope: { ...scope, cwd: O } }))?.message).toBe("Command blocked because it is not a safe command. Flywheel cannot tell where this command writes (`x`). Write inside the project or the scratchpad. Name the target as a literal path. Do not rephrase the command to reach the same target.");
    expect(await interceptBashCommand(`cd ${P}/missing && touch x`, { scope: { ...scope, cwd: O } })).toBeNull();
    // A trailing redirect belongs to the last command of the list, after the directory change.
    expect((await interceptBashCommand(`cd ${O} && echo x > x`, { scope }))?.message).toContain("outside");
    expect(await interceptBashCommand(`cd ${P} && echo x > x`, { scope: { ...scope, cwd: O } })).toBeNull();
    expect((await interceptBashCommand(`cd ${P}/missing || touch x`, { scope: { ...scope, cwd: O } }))?.message).toContain("outside");
    expect((await interceptBashCommand("cd sub; touch x", { scope: { ...scope, env: { ...scope.env, CDPATH: O } } }))?.message).toContain("outside");
  });
  it("resolves an unset variable's literal fallback outside the roots", async () => {
    expect((await interceptBashCommand(`rm -rf "\${VAR:-${O}}"`, { scope: { ...scope, env: { ...scope.env, VAR: undefined } } }))?.message).toContain("outside");
  });
  it("refreshes worktree registration at every check, including a linked project's main tree", async () => {
    const next = posix.join(base, "later-worktree");
    mkdirSync(next);
    expect((await policy(`touch ${next}/x`))?.message).toContain("outside");
    mkdirSync(posix.join(P, ".git", "worktrees", "next"));
    writeFileSync(posix.join(P, ".git", "worktrees", "next", "gitdir"), posix.join(next, ".git"));
    writeFileSync(posix.join(next, ".git"), `gitdir: ${posix.join(P, ".git", "worktrees", "next")}`);
    writeFileSync(posix.join(P, ".git", "worktrees", "next", "commondir"), "../..");
    expect(await policy(`touch ${next}/x`)).toBeNull();
    expect(await interceptBashCommand(`touch ${P}/x`, { scope: { ...scope, projectRoot: next, cwd: next } })).toBeNull();
  });
  it("does not grant the parent of separate Git metadata", async () => {
    const project = posix.join(base, "separate");
    const metadata = posix.join(O, "metadata");
    mkdirSync(project);
    mkdirSync(metadata);
    writeFileSync(posix.join(project, ".git"), `gitdir: ${metadata}\n`);
    writeFileSync(posix.join(metadata, "config"), "[core]\n\tbare = false\n");
    expect((await interceptBashCommand(`touch ${O}/victim`, { scope: { ...scope, projectRoot: project, cwd: project } }))?.message).toContain("outside");
  });
  it("allows only scratch and sinks for a read-only persona", async () => {
    const readOnly = { ...scope, readOnly: true };
    for (const target of [O, P, U, W]) expect((await interceptBashCommand(`echo x > ${target}/y`, { scope: readOnly }))?.message).toContain("read-only");
    expect(await interceptBashCommand(`echo x > ${S}/y`, { scope: readOnly })).toBeNull();
    expect(await interceptBashCommand("echo x > /dev/null", { scope: readOnly })).toBeNull();
  });
  it("uses the PowerShell dialect on every platform", async () => {
    const powershell = { ...scope, dialect: "powershell" as const, env: { ...scope.env, TEMP: O } };
    for (const command of ["Remove-Item -Recurse -Force .\\build", "Get-ChildItem C:\\ > files.txt", "echo x > $null", "echo x > NUL", `Set-Content -Path '${S}/a' -Value hi`, `Set-Content -Path:'${P}/colon' -Value x`, `Set-Content -Path '${P}/one','${P}/two' -Value x`,
      `Set-Content -Path '${P}\\sub.\\alias.. ' -Value x`,
      `CD '${O}'; Set-Location -LiteralPath '${P}'; Set-Content inside -Value x`,
      `Push-Location -Path '${O}'; Pop-Location; Set-Content inside -Value x`,
      ...powershellLinkParents[resolution],
    ]) {
      expect(await interceptBashCommand(command, { scope: powershell })).toBeNull();
    }
    for (const command of [
      "Remove-Item -Recurse -Force C:\\Users\\x\\other", "Remove-Item $env:TEMP\\foo -Recurse",
      "Set-Content -Path C:\\tmp\\a.txt -Value hi", '"x" | Out-File $HOME\\b.txt',
      "echo hi > C:\\tmp\\c.txt", "Copy-Item a.txt -Destination D:\\x",
      "echo hi > $PWD\\link\\file",
      "Move-Item C:\\tmp\\a .\\a", "Remove-Item \\\\server\\share\\x",
      `rEmOvE-iTeM -LiteralPath '${O}/x'`, `Rename-Item -Path '${O}/x' -NewName y`,
      `Set-Content -Path:'${O}/colon' -Value x`,
      `Set-Content -Path '${P}/safe','${O}/array' -Value x`,
      `Remove-Item -LiteralPath '${P}/safe','${O}/victim'`,
      // A native program's operand keeps its option prefix in the command text.
      `dd if=/dev/null of=${O}/x`, `cp --target-directory=${O} a.txt`,
      ...["rm", "del", "ri", "rd", "rmdir", "erase", "Add-Content", "Clear-Content", "Tee-Object", "New-Item"].map(name => `${name} '${O}/x'`),
      ...["CD", "Set-Location", "sl", "chdir", "Push-Location", "PUSHD"].map(name => `${name} '${O}'; Set-Content -Path upper -Value x`),
      `Set-Location -Path '${O}'; Set-Content upper -Value x`, `Set-Location -LiteralPath '${O}'; Set-Content upper -Value x`,
      ...powershellLinkParents[otherResolution],
    ]) expect((await interceptBashCommand(command, { scope: powershell }))?.message).toContain("outside");
    // PowerShell's Set-Location reads no CDPATH: `cd sub` names `sub` under the current location.
    const cdpath = (entry: string) => ({ scope: { ...powershell, env: { ...powershell.env, CDPATH: entry } } });
    expect(await interceptBashCommand("cd sub; Set-Content inside -Value x", cdpath(O))).toBeNull();
    expect((await interceptBashCommand(`Set-Location '${O}'; cd sub; Set-Content upper -Value x`, cdpath(P)))?.message).toContain("outside");
    for (const expression of [`('${P}/x')`, `@('${P}/x')`, `$('${P}/x')`, `{ '${P}/x' }`]) {
      expect((await interceptBashCommand(`Set-Content -Path ${expression} -Value x`, { scope: powershell }))?.message).toContain("cannot tell");
    }
    // Windows trims the final name `...` to nothing, so no file placement is known.
    const trimmedAway = (await interceptBashCommand(`Set-Content -Path '${P}\\sub\\...' -Value x`, { scope: powershell }))?.message;
    if (resolution === "windows") expect(trimmedAway).toContain("cannot tell");
    else expect(trimmedAway).toBeUndefined();
  });
  it("records one content-free refusal and no records for allowed writes", async () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {});
    try {
      expect(await policy("touch inside")).toBeNull();
      expect(record).not.toHaveBeenCalled();
      expect((await interceptBashCommand(`rm ${O}/private-name`, { scope, ids: { sessionId: "s", toolUseId: "t", modelRequestId: "m" } }))?.message).toBe(`Command blocked because it is not a safe command. This command writes \`${O}/private-name\`, which is outside the project, the .flywheel folders, and the project's registered worktrees. Write inside the project or the scratchpad instead. Do not rephrase the command to reach the same target.`);
      expect(record.mock.calls).toEqual([[{
        type: "agent.shell.write_refused", sessionId: "s",
        payload: { rule: "outside", effect: "delete", tool: "bash", toolUseId: "t", modelRequestId: "m" },
      }]]);
    } finally { record.mockRestore(); }
  });
  it("fails open when target analysis cannot complete", async () => {
    const warn = spyOn(Log.create({ service: "bash-command-policy" }), "warn").mockImplementation(() => {});
    const record = spyOn(DebugLog, "record").mockImplementation(() => {});
    const registry = spyOn(writeRoots, "registeredWorktreeRoots").mockImplementation(() => { throw new Error("unreadable registry"); });
    try {
      expect(await policy(`rm ${O}/x`)).toBeNull();
      expect(await policy(`rm ${O}/x`)).toBeNull();
      registry.mockRestore();
      const convergence = spyOn(ShellState.prototype, "same").mockReturnValue(false);
      try { expect(await policy("while true; do printf ok; done")).toBeNull(); }
      finally { convergence.mockRestore(); }
      let nested = "touch safe";
      for (let i = 0; i < 9; i++) nested = `eval '${nested.replaceAll("'", "'\\''")}'`;
      for (const command of [
        `${"env ".repeat(17)}touch safe`, `${"command ".repeat(17)}touch safe`, nested,
      ]) expect(await policy(command)).toBeNull();
      expect(warn.mock.calls).toEqual([["bash command analysis unavailable; analysis-dependent checks skipped", { phase: "targets" }]]);
      expect(record.mock.calls.filter(([entry]) => entry.type === "agent.shell.write_refused")).toEqual([]);
    } finally { registry.mockRestore(); warn.mockRestore(); record.mockRestore(); }
  });
});
