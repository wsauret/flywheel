# Distribution Architecture Intent

This file states how Flywheel builds and publishes releases, installs builds, and activates and collects them on an account.

## ARCH-DISTRIBUTION-001: One build moves as one unit

A build is one inseparable unit of the executable, its native payload, the universal tokenizer asset, the platform's Claude engine, fonts, and the complete built web client, and each target's archive carries all of it. Nothing replaces part of a build, and nothing replaces a build's directory in place.

Because: A running process loads native, tokenizer, and browser assets lazily, so a partial or in-place replacement makes it read another build's files.
Not: Replacing the executable, or a version directory, in place.

## ARCH-DISTRIBUTION-002: A release becomes public only as one complete verified set

A release becomes public only after every required asset of the full supported target matrix is built, verified, uploaded to a draft, and checked as one set, and a failed publication leaves no public release. The release command on the operator machine is the sole publication authority, and it publishes exactly the clean tree that it gated. Every normal release is strictly newer than the current latest release, so publication never moves the latest release backward.

Because: The operator machine runs the full gate, including the release performance suite against the exact host archive that it publishes.
Not: Publishing releases from CI such as GitHub Actions.

## ARCH-DISTRIBUTION-003: The package manifest is the version authority

The repository's package manifest is the version authority, and a release tag is exactly the letter v followed by that strict major.minor.patch version. A version and a build identity must each be a valid single directory name on every platform.

## ARCH-DISTRIBUTION-004: One universal tokenizer asset per release

One source rebuild per release produces and verifies the universal local-tokenizer asset, and every target archive reuses that one asset in its build's native payload. Each process loads it lazily from its own immutable build, so ordinary development, startup, and token counting need neither Rust nor a tokenizer network request.

## ARCH-DISTRIBUTION-005: Native payloads are built fresh and launchers are staged unchanged

Each release target builds and verifies the repository-owned native addons from current source, and every third-party native dependency is a verified prebuilt. Darwin native payloads are signed and verified before the build identity is computed, and installation never changes those bytes. The macOS account-service launcher is one release-invariant program at a stable account path. It runs the installed command as its child and passes signals and exit status through. It and the Windows launchers are tracked binaries that every build verifies against their manifest and stages unchanged.
Because: macOS privacy consent is granted to the exact bytes of the account-service launcher, so it must hold across every update.
Not: Rebuilding or re-signing the launchers in each release.

## ARCH-DISTRIBUTION-006: The third-party license bundle derives from its authorities

The third-party license bundle is generated from the locked production dependency graph and the committed native-dependency ledgers, and the release gate fails when either authority and the generated bundle disagree.

## ARCH-DISTRIBUTION-007: The release repository is the publisher trust root

The configured release repository and ordinary HTTPS validation are the publisher trust boundary. The default is the repository that the build's release compiled in (ARCH-DISTRIBUTION-034). A repository override is configuration that changes the trust root. The release manifest binds each asset to its size and SHA-256 digest, which proves integrity and is never described as a signature or publisher authentication.
Because: An application signing key adds private-key custody, rotation, and recovery without a separate distribution trust requirement.
Not: An embedded application-level release-signing key.

## ARCH-DISTRIBUTION-008: An installed updater refuses only what a correct release can never fail

An installed updater refuses a release in four cases only. These are a hop that is not HTTPS, an archive whose size or digest differs from the manifest, an entry that escapes its staging, and a staged build that does not start. It reads only the manifest fields that it acts on, treats every other field and asset as opaque, and follows redirects to any HTTPS host. Every other restriction on a release lives on the release side.
Because: A client already in the field cannot learn a rule that a later release needs, so any extra client rule can strand an installation.
Not: Client-side limits on redirect hosts, sizes, entry counts, or total transfer time.

## ARCH-DISTRIBUTION-009: The release refuses what a served client would refuse

Before a tag, the release gate runs the update code of each served updater generation, from its oldest tag, against the staged release, and checks the release contracts that every integrity-only client depends on. The served clients are every release published from the first integrity-only release on, and a release listing that cannot be read fails the gate. A generation groups releases that run identical update code, so the gate's cost grows with changes to that code, not with the number of releases.

## ARCH-DISTRIBUTION-010: Versions are read, not judged

The updater orders versions by SemVer precedence and treats a version that it cannot read as SemVer as newer than any other, because the release side publishes only forward. A source run is marked by the absence of a release version in the binary, never by the shape of a version.

## ARCH-DISTRIBUTION-011: An archive is verified whole before it is read

The updater stages the compressed asset in one bounded file and proves its size and digest before it decompresses or parses any byte. Extraction checks only confinement, writes nothing of an archive with an escaping entry, and places only the entry kinds that every platform can place without privilege. The run of the staged build, not the archive listing, decides whether a build can start.

## ARCH-DISTRIBUTION-012: Update transfers are bounded by stalls, not by total time

An update transfer has no total-time bound. A stall bound abandons a silent connection. Stalls, transport failures, short bodies, server errors, and rate limits are retried and resumed from the delivered byte when the host supports it. The updater gives up only after a long period with no byte across a complete backoff ladder, and the next scheduled check starts again.
Because: Ordinary outages such as a Wi-Fi reconnect must not fail an update, and a slow link that keeps delivering must finish.

## ARCH-DISTRIBUTION-013: Bootstrap resolves one immutable tag, and builds state their own target

A bootstrap installer resolves the latest release once to a strict tag and fetches the checksum and the archive only through that tag, so metadata and payload never come from different releases. Each build states the target it was built for, so an update installs the same kind of build without detecting the target again.

## ARCH-DISTRIBUTION-014: One install engine owns installation on every platform

One install engine in Flywheel's own runtime owns extracted-tree validation, immutable placement, platform preparation, the run proof, fenced activation, rollback, launcher publication, and account-service initiation on every platform. Bootstrap and archive installers only locate the extracted binary, invoke its install role, and write the PATH entry, and no script runs in an update. Extraction runs in process, and the only external commands that an installation launches are the macOS quarantine clear and the service registration.

Not: Shell or PowerShell installers that own layout or activation.

## ARCH-DISTRIBUTION-015: Installed builds are immutable and named by content

Each installed build is written once, never replaced, and lives in one account-global directory named by its version and a content-derived build identity. Reinstalling the same build is a no-op, and a same-version rebuild gets a new identity. The installer proves that what it stages, places, and activates digests the same as the verified payload. Every installed-data path derives from the account data root.

## ARCH-DISTRIBUTION-016: A build runs on this host before it takes a name

The install engine runs a staged build once with its own native directory. The build must answer its version before it takes its name. The engine asks a build already in place the same question before activation. A refused build leaves no named tree, and the active build and the launcher stay as they were.

## ARCH-DISTRIBUTION-017: Activation is one atomic replacement of the active-build entry

One active-build entry, a relative symlink on macOS and Linux, names the active build. Activation replaces it by one atomic rename after the complete build is staged and verified and before every launcher change, so every refusal and crash window leaves the previous command whole. The launcher resolves the entry to its physical build, gives the process that build's native directory, and runs nothing that is not a build directly under the account's versions root. Each process stays pinned to the physical build that it started from.

## ARCH-DISTRIBUTION-018: A process names its build from its own executable

Every Flywheel command reads its own build identity once, from its own executable, at entry, and the service and the terminal name their build by that read. The active-build entry is never a build identity.

Because: An install can move the active-build entry at any moment after a process started.

## ARCH-DISTRIBUTION-019: Every process declares the installed build it runs

Every process that runs an installed build declares that build for its whole life in an account-global liveness registry outside the build tree. The declaration is ephemeral liveness, not durable state: nothing projects or replays it, and a reader removes an entry whose process is gone. A build's own tree is never written to.

## ARCH-DISTRIBUTION-020: One fenced account lease serializes update work

One account-global update authority owns the last successful check and one fenced update lease. Every claimant reaches it: the account service, the manual update command, installers, the service of each lane, and an older service that has not retired. The fence is the authority, so a claimant whose fence another claimant advanced can neither publish a check nor activate. The filesystem rename precedes the database commit, so the authority never claims an activation that the filesystem has not made. The next claimant repairs a stale check from the filesystem, which is the truth for the active build.
Because: An atomic rename prevents a torn link but does not order two valid candidates, and project-local coordination cannot serialize an account-global mutation.
Not: A per-project cache, lock, or timer, or an atomic rename without a fenced authority.

## ARCH-DISTRIBUTION-022: One policy store owns the auto-install setting

The auto-install setting is the only durable update preference, and one policy store is its only reader for admission. Final activation rereads it from that store, as ARCH-RUNTIME-066 requires, and an unreadable policy answers no. After each write, the published policy is the reread store value, never the value the caller asked for.

Because: A successful disable must revoke every later activation, including one that is already staging.

## ARCH-DISTRIBUTION-023: The active build moves forward only

Activation refuses a candidate older by SemVer precedence than the physical active build. An installation never moves backward automatically, except the rollback of an unproved build to the last proved build, and a client that already runs a newer release needs a fixed-forward release. Marking an older release as latest is an operator rollback that reaches only new installs and clients that have not advanced.

## ARCH-DISTRIBUTION-024: A build is proved only by a project that opens

A build is proved on an account only when one of its project executors reports ready. An unproved build rolls back under the update lease to the last proved build after repeated service starts that end before they listen. So do repeated project opens that fail by the build's own failure. A requested stop, an outside signal, or an account-side error never counts. The rolled-back build stays installed but refused, and only a release newer than it installs. A proved build is never rolled back. A refused build is never recorded as proved, and a proof never clears a refusal.
Not: Proving a build by its account service's listen.

## ARCH-DISTRIBUTION-025: Update bookkeeping never keeps a working build from starting

The start record and the refused-build record never keep a working build from starting. A build that meets a record of an unknown shape reports it once. It replaces that record with its own shape or reads it as naming no refused build. The proof of a build is written fail-open.

## ARCH-DISTRIBUTION-026: Builds are kept by proof of use, never by age

A build is kept while the active-build entry names it, the collecting process runs it, or a live declaration names it. It is also kept as the start record's last proved build or as one of the retention band's newest builds. Any other build may be removed. Modification time only orders that band and never decides that a build is unused. An account whose active-build entry cannot be read keeps every build, and a directory that states no build metadata is never touched.
Because: Age is not liveness: a sleeping process outlives any freshness window.
Not: Timestamp-based garbage collection.

## ARCH-DISTRIBUTION-027: Collection runs under the update lease inside the update flow

Collection runs inside an update run, takes the account update lease itself, removes nothing when it cannot win the lease, and has no second scheduler. A build leaves the installed set by rename before it is unlinked, so a later sweep reclaims any remainder that an interruption leaves. A staging remainder is removed only when the process that its name states is gone. A sweep is bounded by its lease term and stops between removals when withdrawn.
Because: The lease is what stops an activation from pointing at a tree that the sweep already chose to remove.
Not: Collecting at launch.

## ARCH-DISTRIBUTION-028: Windows activation and collection use Windows' own proofs

On Windows, the active-build entry is a pointer file that activation renames into place with a bounded retry, and the tracked launchers read it and run the named build in a kill-on-close job. A refused deletion of a running executable is the only liveness proof on Windows, so collection deletes a renamed build's executable first and restores the tree whole on refusal. A running launcher is replaced by renaming it aside and is deleted once Windows allows it.

Because: An unprivileged Windows process cannot create a symlink, replace a directory in one rename, or delete a running executable.
Not: A junction as the activation link.

## ARCH-DISTRIBUTION-029: Legacy layout cleanup requires exact ownership proof

An installer removes or converts a legacy flat installation only under the exact manifest or wrapper that the earlier installer wrote. It keeps the installation's entries until nothing runs them, and leaves an unrecognized entry unchanged with a remediation message. An install record of a shape that the engine does not know refuses the installation with a warning. Cleanup never follows a link or deletes a directory by its name alone.

## ARCH-DISTRIBUTION-030: A dev service runs one source snapshot under the build proof rule

Every command of the dev entry runs from one snapshot of its checkout's source, fixed when the command starts. Every process of a dev service, including its Workers, guardian, executors, supervisors, and bundled engine programs, loads that same snapshot and its web client. Each snapshot is a build of the dev lane under the same proof and refusal rules as an installed build, and an unreadable proof record lets no sweep remove a snapshot.
Because: Agents edit the checkout, so a running service must never restart onto a half-written tree.

## ARCH-DISTRIBUTION-031: A terminal's launch state crosses a re-execution once

When a terminal re-executes into the serving build (ARCH-RUNTIME-036), it carries the person's place in one owner-only launch-state contract that travels by environment and that the successor parses strictly and consumes once. A launch state that the successor cannot read starts it plain, and never fails a start.

Because: A build that predates the contract must still start, so the state travels by environment rather than by an argument that an older build would reject.

## ARCH-DISTRIBUTION-032: The editor extension carries no runtime

The editor extension carries no runtime. It installs only on a machine with no Flywheel, and only by running the platform's bootstrap installer, unpinned. It finds the result by the installer's placement rule, not by PATH. Verification, placement, activation, and registration stay with the installer and the install engine. One universal extension package serves every platform and publishes only after the release whose protocol it speaks is public.
Because: Installing over an older installation from the extension would bypass the auto-install policy.
Not: Bundling a runtime in the extension.

## ARCH-DISTRIBUTION-033: The relay deploys on its own and its hostname is permanent

The relay Worker and the phone's hosted bootstrap deploy manually from the same tree as the binary, separately from every release, and nothing deploys a client to hosting. The relay hostname is a permanent commitment that pairing codes and the binary default carry. The relay speaks one protocol version. It deploys before any build that speaks a new version reaches the main branch or a release. The release gate probes the deployed relay's version before it publishes a binary that expects another.

## ARCH-DISTRIBUTION-034: Only the release build compiles in the publisher inputs

Publisher inputs, the update repository and the bug report endpoint, are supplied at build time or by the environment of a source run, and no runtime check infers them. A release build compiles in the repository that the release environment names, or else the official repository, and the report endpoint that the release machine's environment names. Every other build compiles in neither, so it sends no report and installs no release unless the repository override of ARCH-DISTRIBUTION-007 names one. A release to the official repository refuses to start without the maintainers' endpoint, which only the official release machine names.
Because: A fork keeps the whole source and can share an official build's version and build id, so only the build command and its environment can tell the builds apart.
Not: A hard-coded repository and endpoint gated by a release mark, which every fork's release build would carry.
