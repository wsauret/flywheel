# Native crates

This directory holds the native code that Flywheel ships beside its TypeScript. Each crate commits its compiled output next to its source, together with a manifest that records the hash of the source and the hash of each binary.

## Why the binaries are committed

The committed binaries let you work on Flywheel without Rust, Zig, or a C compiler. `bun run dev`, `bun run build:binary`, and `bun run install:local` copy the committed files into the build. They compile nothing when the source and the manifest agree.

The release is different for two crates. The release rebuilds the tokenizer from source and compiles the ripgrep addon from source for each target, so the release machine needs Rust. The launchers and the Git forwarder are never rebuilt by a release. The release verifies them and copies them.

## How a binary is tied to its source

Every build that copies a committed binary first checks it against its manifest:

- It hashes the binary and compares the result with the recorded binary hash.
- For ripgrep, the launchers, and the Git forwarder, it also hashes the crate source and compares the result with the `sourceSha256` in the manifest. For the tokenizer, `bun run build:tokenizer --verify` does the source check. The release and release readiness run it.

A mismatch means that someone changed the source and did not rebuild, or that the binary changed. For the launchers, the Git forwarder, and the tokenizer, the build stops with an error. For the ripgrep addon, the build tries to rebuild the addon from source, and stops when it cannot produce a binary that matches.

## Change the source of a crate

The unit suite checks the committed Windows launchers, the Git forwarder, and the macOS launcher against their source, and it stages the ripgrep addon of the machine that runs it. Thus, a source change without a rebuild makes `bun run test` fail, locally and in CI.

- If you have the toolchain of the crate, rebuild it with the command in its section below. Commit the source, the binaries, and the manifest together.
- If you do not have the toolchain, open the pull request with the source change only, and say so in the description. The unit suite then fails on the native assets of that crate. That failure does not block the review.

The maintainer rebuilds every committed binary from its source before merging and compares the result with the binaries in the pull request. The maintainer never merges a binary that a contributor built without that rebuild and comparison. When the bytes differ, or the pull request has no binaries, the maintainer commits the binaries of the rebuild to the pull request, so that CI passes before the merge.

## ripgrep

The search engine of the grep and file-listing tools. It is a Node-API addon written in Rust.

- Artifacts: `flywheel-ripgrep.<platform>.node` for each of the eight release targets (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `win32-x64`, `win32-arm64`), and one `native-prebuilt.<platform>.json` for each.
- Fingerprint: `native-prebuilt.<platform>.json` holds `sourceSha256` and `binarySha256`. The source hash covers `Cargo.toml`, `Cargo.lock`, `build.rs`, and every `src/**/*.rs` file, with line endings normalized.
- Rebuild for this machine: `bun run build:ripgrep`.
- Rebuild for another target: `bun run scripts/build-ripgrep.ts --platform-arch=<platform>`. The `build:ripgrep:linux-*` and `build:ripgrep:windows-*` scripts are shortcuts for four of them.
- Toolchain: Rust with cargo, and the rustup target of each platform you build. A Linux target built on another system also needs `cargo-zigbuild` and Zig. A Windows target built on another system also needs `cargo-xwin`.
- The build writes the addon, records its fingerprint, and regenerates `THIRD-PARTY-LICENSES.txt` from the Cargo dependencies.
- After a source change: rebuild all eight targets and commit the addons, the fingerprints, and `THIRD-PARTY-LICENSES.txt`. `bun run scripts/build-native-addon.ts --crate=ripgrep --verify` confirms that every committed addon matches the source. It needs no Rust.

## tokenizer

The local token counter. It is a Rust crate compiled to one WebAssembly module that every platform uses. Flywheel loads it lazily when it counts tokens.

- Artifacts: `flywheel-tokenizer.wasm.zst` (the compressed module) and `tokenizer-prebuilt.json` (its fingerprint).
- Fingerprint: the manifest records the pinned toolchain, a `sourceSha256` over every file in the crate and `scripts/build-tokenizer.ts`, the hashes of `Cargo.toml`, `Cargo.lock`, the vocabularies in `data/`, and the test fixtures, the module ABI, and the hash and size of the compressed and uncompressed module. Each build checks the hash and size of the compressed module.
- Rebuild: `bun run build:tokenizer`.
- Toolchain: the Rust toolchain `nightly-2026-07-28` with the `wasm32-unknown-unknown` target, installed through rustup. The script refuses to build with any other compiler.
- The build checks the new module against 1572 token counts from the fixtures before it writes anything.
- After a source change: rebuild, then run `bun run build:tokenizer --verify` and commit the module and the manifest. The verify step needs no Rust. It recomputes the complete fingerprint from the committed files and runs the fixture checks again.

## windows-launcher

The two small programs that start Flywheel on Windows. `flywheel.exe` is the console launcher on PATH. `flywheel-service.exe` is the windowless launcher that Task Scheduler runs for the account service. Both read the pointer to the active build and run that build. Windows does not let a program replace a file that is in use, so these programs are the one stable file across updates.

- Source: `launcher.c`. The service variant is the same source compiled with other flags.
- Artifacts: `flywheel-launcher.<platform>.exe` and `flywheel-service-launcher.<platform>.exe` for `win32-x64` and `win32-arm64`, and `launcher-prebuilt.json`.
- Fingerprint: `launcher-prebuilt.json` holds the `sourceSha256` of `launcher.c`, with line endings normalized, and the hash and size of each executable.
- Rebuild: `bun run build:windows-launcher`.
- Toolchain: Zig 0.15.2 (`zig cc`), whose license texts `THIRD-PARTY-LICENSES.txt` carries. It cross-compiles from macOS, Linux, or Windows.
- After a source change: rebuild and commit `launcher.c`, the four executables, and the manifest together. The output is deterministic, so a rebuild of unchanged source changes no bytes.

## windows-git-forwarder

A small `git.exe` that Flywheel puts first on PATH for one mutating command on Windows. It forwards the Git arguments, unchanged, to the pinned Flywheel runtime, which applies the Git policy. It is not the account launcher.

- Source: `launcher.c`.
- Artifacts: `flywheel-git-forwarder.<platform>.exe` for `win32-x64` and `win32-arm64`, and `launcher-prebuilt.json`.
- Fingerprint: the same manifest format as the Windows launcher.
- Rebuild: `bun run build:windows-git-forwarder`.
- Toolchain: Zig 0.15.2 (`zig cc`), from any host.
- After a source change: rebuild and commit `launcher.c`, both executables, and the manifest together.

## macos-launcher

The program that launchd runs for the account service on macOS. It starts `flywheel serve` as a child process and waits for it. macOS privacy consent attaches to this program, which does not change between releases. Thus, an update does not ask the user again for access to protected folders. The program ships in a minimal application bundle, so that macOS shows it with the Flywheel name and icon.

- Source: `launcher.c`. The icon comes from the brand tile in `src/protocol/client/brand.ts`.
- Artifacts: the `Flywheel.app` bundle (the universal executable, `Info.plist`, `PkgInfo`, `Flywheel.icns`, and the ad-hoc code signature), and `launcher-prebuilt.json`.
- Fingerprint: `launcher-prebuilt.json` holds the `sourceSha256` of `launcher.c` and the hash and size of every file in the bundle. A file that is missing or not in the manifest is also an error.
- Rebuild: `bun run build:macos-launcher`.
- Toolchain: macOS with the Xcode command line tools (`clang`, `iconutil`, and `codesign`).
- After a source change: rebuild and commit the bundle and the manifest together. Do not rebuild without a reason. A rebuild gives the program a new code identity, and every macOS user must then grant consent one more time.

## Third-party code

Some crates adapt third-party code or compile in third-party libraries. Their notices are in `THIRD-PARTY-NOTICES.md` at the root of the repository.
