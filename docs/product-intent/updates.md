# Updates Product Intent

This document states the current intended experience for installation integrity, replacement, and release activation.

## PI-UPDATES-001: A corrupted installation is replaced safely

Flywheel replaces a corrupted active installation with a fully verified newer release without modifying files used by the running version.

## PI-UPDATES-002: A Mac asks for folder access at most once

On a Mac, Flywheel asks for access to a protected folder such as Documents at most once for the account service, and installing a newer release never asks again. The request and its entry under Privacy & Security are named Flywheel and carry Flywheel's icon.

## PI-UPDATES-003: Updates keep saved state working

Installing a newer release keeps every saved login, model selection, model preference, and saved provider catalog working without user action, and never asks the person to repair a file by hand. When Flywheel meets saved state in a shape it does not know, it keeps that state as it is and says so; it never treats that state as empty.

## PI-UPDATES-004: Clients and running work move to the new release

After Flywheel activates an update, connected clients reconnect to the new release on their own and running work continues there (PI-REMOTE-012, PI-REMOTE-019, PI-REMOTE-020), including shell commands that are still running. No running work delays the switch. When an update or a restart replaces the service, a shell command still in the foreground moves to the background as a Detach does, and its row then offers Stop in place of Detach. The terminal returns to the same open tabs and foreground session after activation.

## PI-UPDATES-028: A client of the new release waits for the handover

A client started from the new release that finds the previous release still running waits as an ordinary start while the previous release hands its work over, and never fails because the two releases differ.

## PI-UPDATES-029: An update always leaves an account service

An update never leaves the account with no account service: the new release serves after activation also when no client is connected and Process initiation is Off.

## PI-UPDATES-005: Clients replace themselves with the serving runtime's client

The editor, a browser, and the desktop app show the client that belongs to the serving runtime. Activating a newer release replaces that client without an extension update and without the person doing anything. The new client keeps every draft with its attached files, question picks, the focused field with its selection, the reading place, and opened rows, and the person can type until the moment of replacement. When the replacement fails, the current client stays as it was, with its input intact, and says that it could not update.

## PI-UPDATES-030: The desktop app moves with the release

The desktop app belongs to the installed release and needs no update of its own. After a newer release activates, the app restarts into it the next time its window closes.

## PI-UPDATES-006: The editor extension installs and starts Flywheel

Installing the editor extension on a machine with no Flywheel installs the current release without a prompt, and that installation updates the way a terminal installation does. When the editor starts Flywheel, it waits as long as the start takes; after fifteen seconds it says what the start waits for and how long it has waited. A start that fails shows its cause and remedy. When the editor finds a Flywheel older than it supports, it refuses it, says so with the remedy, and never installs over it.

## PI-UPDATES-007: The terminal installer reports progress plainly

The terminal installer shows version information, download progress when downloading, and clear start instructions after success. Internal diagnostics do not interrupt normal installation output.

## PI-UPDATES-008: A release that cannot start rolls back

When a newly activated release cannot start or open any project on this machine, Flywheel returns on its own to the release that last opened a project there. It does not install the failed release again; a newer release installs normally. While Flywheel runs a release older than one that failed, the update status in every client names the release that could not start here instead of saying that Flywheel is up to date. No notice interrupts the person about it. When the failed release has the running release's version, the status also names its short build identity.

## PI-UPDATES-009: A source run falls back to source that starts

In a source run, when the checkout's newer source cannot start or cannot open any project, Flywheel goes back on its own to the source that last opened a project, and running work continues there. It tries the checkout's source again once that source changes. While it runs the older source, the update status in every client names the source that could not start and the source that runs instead.

## PI-UPDATES-010: A source run moves to new source only on request

A running source run never moves to newer source by itself. An edit to the checkout, including one that changes the runtime protocol, leaves every session on the source the service started with. A package install that replaces the Claude engine leaves every session on the engine the service started with. Only a person who starts a new source run, or restarts Flywheel, moves the service to the checkout's current source. A Flywheel client that an agent's command starts never moves or restarts the service that other sessions run on.

## PI-UPDATES-011: Every served installation can update to each release

Flywheel publishes no release that an installation it still serves would refuse, and an installation from the first integrity-only release on updates itself to every later release. A v0.0.x installation, and a v0.1.0 installation whose link is too slow for its download limit or that GitHub redirects outside its release hosts, updates only by a reinstall.

## PI-UPDATES-012: The terminal announces a newly installed release

After Flywheel updates to a newer release, the terminal shows a notice under the welcome card. It names the release that now runs, counts the features, fixes, and other changes that the release notes list since the release the person last dismissed, and links to those release notes. The notice stays until the person dismisses it. A fresh installation, a source run, and a return to an older release show no notice. When the release notes cannot be read, the notice still names the release and the link.

## PI-UPDATES-013: The installers put the command on the PATH

The installers put Flywheel's command directory on the account's PATH. An installer setting declines that edit for a throwaway or managed installation.

## PI-UPDATES-014: The Unix installer refuses a downgrade

A request to the Unix installer for a version older than the active one fails before any download. The refusal names the requested and active versions, says that the installer does not downgrade, and tells the person how to update forward. A request for the same version, a newer version, or the latest release installs normally.

## PI-UPDATES-015: Every build carries its licenses

Every installed Flywheel build carries Flywheel's license, its attribution notice, and the complete third-party license bundle.

## PI-UPDATES-016: One setting controls automatic installation

Automatic installation of newer releases is on by default and one setting controls it. While it is off, Flywheel still checks for a newer release and tells the person about it, but downloads nothing. An environment override can only hold installation off for one run, never turn it on, and the settings row says when the environment holds installation off while the setting is on. A configuration file that cannot be read turns automatic installation off; an absent one keeps the default.

## PI-UPDATES-017: Turning automatic installation off takes effect at once

After the person turns automatic installation off, no release activates from any Flywheel process, including one whose download was already in progress. A change to the setting, made by hand or by another process, shows in every client without waiting for the next release check.

## PI-UPDATES-018: Update failures never block startup

A failed background update check or installation never fails startup and shows no error notice. The update command checks on demand, reports its outcome, exits with a failure status when it fails, and installs nothing while automatic installation is off.

## PI-UPDATES-019: An available release shows why it is not installed

A release that is available but not installed shows why: nothing stands in the way, or automatic installation is off. While automatic installation is off, the notice names the setting to change and never tells the person to run a command that the setting blocks.

## PI-UPDATES-020: Each client shows the update statuses it owns

The web client's Status row names every update status. The terminal's Status row names only a release or checkout source that could not start on this machine, and the composer border shows only a release that the person can take or restart into. The web toolbar shows only a release that is available, installing, or installed.

## PI-UPDATES-021: Updates keep Process initiation off

When the person turned Process initiation off, installing a newer release keeps it off on every platform.

## PI-UPDATES-022: Updates keep module choices from earlier formats

Installing a newer release keeps every module choice that an earlier configuration format recorded, with no action from the person, and rewrites the file in the current format once. When a file records module choices in two formats at once, Flywheel does not rewrite it, names the conflict, and keeps the last valid selection until the person repairs the file.

## PI-UPDATES-023: An older release refuses state that a newer one wrote

When a project holds state that a newer release wrote, an older release refuses to open that state, leaves it untouched, and every client says that updating Flywheel is the remedy.

## PI-UPDATES-024: A client names the release of a runtime it cannot match

When a client cannot replace itself to match a runtime that speaks another protocol version, it shows one refusal that names the release the runtime runs, so the person can tell which side is older. It attaches on its own once the two versions agree.

## PI-UPDATES-026: The install directory setting moves only the command

The install directory setting moves only where the Flywheel command is placed, never the installed builds or the person's data.

## PI-UPDATES-027: Releases come only from the build's own release repository

An official Flywheel release checks for and installs newer releases only from the official release repository. A release that a fork builds updates only from the fork's own release repository. A build that names no release repository, such as a local install or a source run, never checks for or installs a release. The update status in every client says that this build does not update itself because it names no release repository. An environment setting names another release repository for one run.
