# Model Access Product Intent

This document states the current intended experience for authentication, authorization, provider configuration, model eligibility, selection, routing, and failover.

## PI-MODEL-001: Invisible automatic provider failover

Automatic provider failover is invisible while an eligible, authorized fallback exists. Flywheel tries candidates in resolution order within the same logical turn and tool call, preserves completed work, and attributes usage and cost to each provider attempt. Flywheel passes over a candidate only when its quota or credits are spent, it rate limits, it is overloaded or unreachable, or its account lacks the model or the model's extended context window. It reports a terminal quota failure only after every candidate in every authorized spend class has run out or is ineligible.

## PI-MODEL-058: Failover order spends expiring included quota first

Flywheel orders failover candidates by spend class: included subscription use first, then prepaid balance, automatic subscription spend, direct API spend, and aggregator spend. Inside a class, candidates follow provider rank and then account order. For included use of a provider whose accounts reset at different times, such as Claude, the soonest known reset of the expiring quota decides before account order. An account with no known future reset follows those with one, and a chat leaves its current account when another account's quota expires sooner.

## PI-MODEL-059: A failure the request caused is reported at once

When the request itself caused a failure, such as a rejected or malformed request, bad credentials, or an error the provider did not classify, Flywheel reports it at once instead of trying other candidates. The report names that failure and never describes it as spent quota or credits.

## PI-MODEL-060: A failing candidate is retried in place before failover

Flywheel retries a candidate that drops the connection, throttles, or reports overload in place with bounded backoff, and moves on only when those retries are spent. The session status shows the reconnect progress while it waits. A lost connection alone never marks a provider unreachable for other sessions, and only a failure the provider stated does. A first mark holds briefly and lengthens only while the outage persists.

## PI-MODEL-083: A response whose reasoning repeats itself is resampled

When a model's reasoning collapses into repetition, Flywheel stops that response and requests a fresh one from the same provider, at most twice per response. The last fresh response runs without reasoning where the model allows that, and Flywheel accepts it in full. The session status says the model repeated itself, and each stopped attempt appears as its own request.

## PI-MODEL-002: Background process model visibility

Background process lists prioritize the full, wrapped goal and show the current resolved model and reasoning effort for each process that has one. Internal process identifiers are not displayed.

## PI-MODEL-003: Actionable unsafe account storage

When unsafe account storage blocks model access, Flywheel identifies the affected provider and storage path. It marks that provider as needing attention in Authentication and raises one actionable provider-specific notification. It stops retrying affected candidates until the credential store changes, keeps completed work, and lets the session retry after repair. If the file names no affected provider, Flywheel reports the authentication file itself.

## PI-MODEL-005: Subscription usage threshold crossings

Flywheel notifies once on an observed crossing from below each configured subscription usage threshold. A first observation already at or above the threshold is silent. A threshold becomes eligible again only after observed usage falls below it. Notifications identify the subscription and relevant usage window, use whole-number percentages, and include days until reset when known.

## PI-MODEL-006: Banked subscription usage resets

Usage lists every available banked reset with its expiration, earliest first. Its one Apply action reviews the earliest-expiring reset, which applies only after the user confirms it. The provider decides at redemption whether a limit resets, and Flywheel reports that outcome and refreshes usage after it. In an interactive client, when no provider can serve a request and an account refused for used-up included usage has a banked reset, the refusal says so and points to Usage to apply it.

## PI-MODEL-004: Consolidated model identity

Equivalent provider spellings and stable route variants of one model appear and persist as one dotted model choice. Each provider receives the exact identifier of the selected eligible route. A dash between numbers becomes a dot only when a version follows it. For example, claude-opus-4-5 appears as claude-opus-4.5, but qwen3-8b stays unchanged. Dated snapshots appear under the model's undated identity. It routes to the provider's undated identifier if one exists, else the newest dated one. A moving provider alias is never a model identity. The model behind it takes the snapshot name that models.dev records, or else the alias.

## PI-MODEL-047: Saved model choices survive identity changes

A model pinned in Flywheel's configuration file, or chosen in an account's model preferences, under a spelling that an earlier release used keeps working. Flywheel rewrites it to the current identity once the catalog names that model.

## PI-MODEL-048: Model lists show only routes that can do coding work

A provider route is listed only when it has a known price, calls tools, and takes and returns text. A batch-only route is never listed. A stable provider model stays listed when its own provider describes nothing about it, as long as another source prices it and states that it calls tools on text. User-authored custom provider models are always listed.

## PI-MODEL-049: A provider's free wire is a free route of its model

A provider's free wire, such as an OpenCode Go identifier that ends in -free, is a free route of its model when the provider also serves that model on a paid wire. An account uses such a free route only when its free routes are on. A free wire of a model that has no paid wire is that model's own route and serves it without free routes.

## PI-MODEL-013: Profile-scoped training-route consent

Contributor routes are ineligible unless the active auth profile explicitly allows providers to train on requests sent through those routes. No other profile or account-wide value fills in for this permission, and a change applies from the next model request.

## PI-MODEL-017: Account-scoped OpenRouter free routes

OpenRouter free routes are off by default. For an exact OpenRouter account that includes them, Flywheel shows free variants under the same model choices, prefers an eligible free route, and retains that account's paid route as fallback. This preference does not grant contributor or training-route permission.

## PI-MODEL-014: Automatic session naming resumes after access recovery

When a recoverable authentication or provider-configuration condition blocks automatic session naming, Flywheel keeps the immediate quick title and retries naming after that environment refreshes, without delaying chat work.

## PI-MODEL-007: Consistent provider request identity

Provider requests identify Flywheel consistently wherever the provider permits application attribution, while required provider compatibility identities remain intact.

## PI-MODEL-008: Model assignment inheritance indicator

Model assignment lists show only the ↳ glyph when the effective model and effort both match the inherited pair, and show no indicator when either value differs.

## PI-MODEL-009: Provider controls target exact accounts

Provider and account rows open Provider Settings, whose subscription model controls apply to the exact account being edited. Extra billing is account status, not a model-selection target. New credentials replace rejected credential data rather than preserving its rejection. Account settings distinguish usage status from model access and recommend recovery actions for the reported condition.

## PI-MODEL-061: Authentication list navigation keeps the selected row in view

Arrow-key navigation in the authentication list keeps the selected row visible. Revealing the first row of a section or provider group reveals the headings immediately above it when they fit with the row. The selected row takes priority when the viewport cannot fit both.

## PI-MODEL-012: Complete searchable provider catalogs

Every provider account's model controls show at once every usable stable model in that account's latest valid catalog, even one no other catalog matches. That catalog is the account's saved first-party catalog, refreshed in the background. The models.dev catalog replaces it when discovery is unavailable or unusable, and joins it when the provider lists only part of what a login serves. It is never a separate provider or picker section. People can search the complete list, sorted newest release first, edit it, and deselect all its models, even when discovery fails or the account cannot send requests.

## PI-MODEL-085: Undiscovered accounts show as being discovered

An account whose model discovery has not yet run shows as still being discovered, never as failed or unavailable.

## PI-MODEL-064: Only checked models of a current account serve requests

Outside provider controls, only models checked for a current exact account enter model selection and request routing. An enabled model in the account's latest valid catalog is eligible for requests at once, unless it waits for an access check. Viewing or editing preferences never authorizes requests, and an account whose authentication is rejected serves no requests until a new credential replaces it.

## PI-MODEL-065: Unconfirmed models are checked before they serve

SuperGrok and Google Vertex accounts show usable coding models from models.dev at once as editable preferences, and so do Claude subscription accounts for models their login does not list. Background checks that never bill or enable paid use confirm what each account can serve. Pending models stay unchecked unless the person selects them, and the profile's auto-enable default applies only after a successful check. Only a successful check makes a model eligible for requests.

## PI-MODEL-084: Access check results persist until a recheck

An inconclusive access check never erases an earlier success. An explicit refusal hides the model, and every background discovery checks it again, so a model that an account gains appears after the next discovery. A manual recheck checks every model of the account at once. Every check result survives restart and token refresh.

## PI-MODEL-066: A model refusal affects only that model and account

A provider's refusal of a model, or of only its extended context window, applies to that model on that account alone. Flywheel does not retry the refused model or window on that account, mark the provider unreachable, or mark the account's quota spent. When no candidate can serve the request, the notice names the refused model or window and offers the model command, never a rate limit. The refusal survives restart and token refresh. It ends after 24 hours, when the account gets a new credential, or when an access check of the model changes from refused to passed.

## PI-MODEL-067: A refused model or window leaves the account's offer

When a provider states that an account cannot use a model, the model leaves that account's model controls and request routing. When a provider refuses only the extended context window, the account offers the model at the standard window, and the next message uses that window and compacts the session first when it does not fit. When that refusal comes before any part of the response, Flywheel sends the same request once more at the standard window instead.

## PI-MODEL-068: New provider models follow one enablement default

Flywheel never maintains or curates which models a provider offers. New models default to enabled under one policy that covers the active auth profile and every provider account in it. Changing that policy keeps current selections and every explicit deselection on an account.

## PI-MODEL-010: Usage reads the same way on every client

Usage is one view with Accounts, Spend, and History a tap apart. A line beside the switch gives the reading's time and whether it is refreshing, delayed, or failed, and never hides the reading or switch. Each account row shows its name and one reading of what is left or why there is none, above its plan, signed-in identity, and paid-use permission. Accounts start closed; a tap opens one at a time or closes the open one. An open account shows a bar per provider window with its reading and reset time, its banked reset with Apply, and Flywheel's activity.

## PI-MODEL-052: Usage account rows fit each account's provider

An Anthropic subscription account's headline shows its weekly all-models usage window, and its details show the five-hour window and each weekly per-model window under the model's name. ChatGPT per-model windows stay hidden until the person asks for them. A Claude usage-only enterprise account reads as a metered account, with no provider allowance or usage windows, only what Flywheel tracked and billed. No account row shows an internal account id.

## PI-MODEL-053: Usage reports each account's tracked activity

Each account's Flywheel activity reports the current local calendar month and each current account-wide provider usage window separately, with explicit date ranges. While Usage is open, tracked activity updates as model requests are recorded. Missing or partial accounting is explicit, and an unknown price is flagged on its account and model and adds no money. A period reads incomplete only while accounting is still settling, and an unavailable ledger reads unavailable, never zero.

## PI-MODEL-054: Spend keeps measured usage apart from billed spend

Spend reads over a chosen range as totals and then each source with its models, and it shows all tracked activity. It shows reported cache reuse, token breakdowns, and measured model-request counts, overall and by account and model, apart from billed spend and subscription-equivalent value. Requests that a provider served without a usage report, or whose report ended early, show beside the measured count as unmeasured or partially measured. An unmeasured request adds no tokens or money, and a partially measured request adds the lower bounds it reported.

## PI-MODEL-055: History charts each account's use over the range

History offers every account, metered keys included, and for a metered key it charts spend climbing through the range to its total. For a subscription it charts each window that the provider still reports and that saw use in the range, rising as the window fills and dropping where the provider reset it. Each reset is marked once while the marks can be told apart, and the latest and peak readings sit beside the window's name. Billed spend beyond the plan charts beneath the window when there was any.

## PI-MODEL-015: Model picker names the providers that can serve each model

The model picker names each model's eligible providers once each, in resolution order for the active auth profile. It never names a model's API format. The provider that would serve the model when the picker reads its models stands out. No provider stands out when none can serve. The terminal shows the highlighted model's providers by full name beneath its price details, joined by arrows. The web client shows one line under each model's name. It lists short provider names up to the serving one and counts the rest, or lists every provider when none can serve.

## PI-MODEL-044: Model picker shows effort and price in place

The model picker shows each eligible model with its supported effort levels and the effort that will apply, which the user can adjust before confirming both. Each option shows the selected role's effort adjusted to the model's levels, and changing one role never changes another role's effort. The picker shows the highlighted model's input, cached input, and output prices per million tokens and their place in the listed models' price range. A model offered through several providers shows one price and one effort set, each value taken from the first provider in selection order that states it, else from models.dev.

## PI-MODEL-045: Confirming a model that cannot serve now keeps the choice

When the person confirms a model that the profile cannot use at that moment, Flywheel keeps the choice. The confirmation names the model and effort that serve until the chosen model is usable, or says that no model can serve now.

## PI-MODEL-046: Model choices refresh quietly in the background

Opening model selection or provider model controls shows saved choices at once and starts background discovery at most once per auth profile every five minutes, failed attempts included. While Flywheel runs, background discovery also runs at least once an hour for each open auth profile. Ordinary background discovery shows no loading transition or success toast while usable choices remain.

## PI-MODEL-016: Every agent role has an eligible default

For every request, Flywheel resolves each agent role against the active auth profile's reachable models. It uses the role's saved model and effort when reachable, then its coded OpenAI preference, then its coded Anthropic preference, then the newest reachable model in its price tier. When that tier is empty, it uses the nearest populated tier, or a reachable unranked model when no ranked model is reachable. An unsupported effort maps to the nearest supported effort.

## PI-MODEL-056: A skipped saved model is announced in the transcript

When a role's saved pair is unreachable, the agent's transcript shows one system message that names the saved model and the model and effort that serve instead. Another such message appears only when the serving selection changes or the saved model serves again. The model never reads these messages.

## PI-MODEL-057: Role selection waits for model discovery

A profile whose model access is still being checked waits on discovery before it selects a model. A profile with nothing reachable shows the existing authentication or no-provider guidance.

## PI-MODEL-011: Paid-provider admission uses provider evidence

Flywheel skips a paid provider candidate before dispatch only when current provider-owned balance and pricing evidence proves the request unaffordable under that provider's billing rules. Unknown affordability remains the provider's decision, and another eligible candidate can serve.

## PI-MODEL-018: Paid use is asked once and never blocks

Connecting a subscription account whose provider reports paid capacity ends with one paid-use question that names the account, explains that paid use stays off until allowed, and offers each paid mode as a choice. Closing the question records that paid use stays off, so it does not return. Paid capacity detected outside a connection flow raises the same question once at the next safe moment, and it never blocks other work. The terminal never asks while the session on screen runs a model turn, and the editor and phone show a notice that a question waits instead of interrupting work.

## PI-MODEL-050: Each profile keeps its own paid-use answer for each account and mode

Each auth profile keeps a separate paid-use answer for each account and each paid mode, with prepaid and automatic billing kept apart. A different profile or account starts with paid use off and unanswered, and a token refresh keeps the answer. The person changes the answer later in Provider Settings.

## PI-MODEL-051: An allowed paid mode serves like an API key

After an account's included usage is gone, Flywheel sends requests through an allowed paid mode as it would through an API key, and the provider decides whether to serve them. Usage readings are shown for tracking and never block an allowed paid mode. Flywheel offers no profile-wide spend limit, billing toggle, or purchase path.

## PI-MODEL-019: Session title model selection

People can choose the model and reasoning effort used for automatic session titles in the Background section of model configuration. Each title request uses the current setting of the session's auth profile and skips an unreachable saved model together with its effort. Without a reachable saved choice, titles prefer GPT-6 Luna at low effort, then Claude Haiku 5.5 at low effort. Otherwise titles use the newest reachable cheap model at low effort, then the nearest populated tier, then any reachable unranked model.

## PI-MODEL-020: Current subagent model visibility

Linked subagent cards and child viewers show the model and reasoning effort that serve the child now, and update when either changes. A model or effort change in a child viewer applies only to that child, at its next request. An unreachable or unsupported model or effort setting falls back to the defaults and never refuses a subagent dispatch.

## PI-MODEL-021: Model selection applies at each request

An agent uses the current effective model, reasoning effort, and provider options at each request boundary, and keeps that selection for the request and its tool calls. A selection change applies to the next request without replacing the runner, losing conversation state, or interrupting background work. General agents inherit the selection of the parent request that starts them.

## PI-MODEL-062: A switch across providers continues the conversation

A switch to a model of another provider, or between the Claude engine and another route, continues the same conversation without a warning, also while tool calls are pending. The agent reads its earlier replies, progress updates, and tool work as its own. It never reads the earlier model's private reasoning, so that reasoning cannot appear as something the agent said.

## PI-MODEL-022: Prefilled SuperGrok sign-in

SuperGrok sign-in opens a verification link with the device code included, without asking the user to copy or enter it.

## PI-MODEL-023: Auth profiles remain available and deletion transfers sessions

Flywheel always provides at least one auth profile. Creating, renaming, or deleting a profile updates already-open clients without a restart.

Deleting a profile first moves its saved sessions and workflows to a destination that the confirmation names, or that the person chooses there when several profiles remain. Deleting the last profile creates a fresh Default that inherits no credentials or profile-specific settings, and its sessions and workflows move to it.

## PI-MODEL-024: Provider-scoped prompt-cache retention

People can set prompt-cache retention for each API provider that supports a retention control, and omitting it keeps the current default. A policy applies from the next request to that provider, including a fallback request, and never changes subscription policies or an explicitly uncached request. A provider refusal identifies a selected model that cannot serve the requested policy. A provider-managed policy does not promise a fixed cache lifetime.

## PI-MODEL-025: Accounts of the earlier native Anthropic Subscription provider move to the Anthropic Subscription provider

When a person installs a release, each Claude account that the earlier native Anthropic Subscription provider stored moves to the Anthropic Subscription provider in the same profile. Its saved model choices and paid-use decisions move with it, and they apply again after the person logs in to that account once from Authentication. Flywheel then deletes the stored Claude sign-in tokens without using them or writing them to a log. Until that login, the Anthropic Subscription row shows its Log in button, not an error, and one notice for each profile names the accounts that need a login.

## PI-MODEL-026: Terminal API-key entry shows a character count

When a person enters an API key at a terminal prompt, the terminal never shows the key, only a count of the characters received that stays current while they type, paste, or edit. When they press Enter, Flywheel confirms the key with the hint that the stored-key status shows, which is the last 4 characters behind a mask or "!command" for a command reference. A cancel leaves no key text on screen, and piped input gets no count or confirmation. The key never reaches a log, an error message, or the prompt's input history.

## PI-MODEL-027: Claude through a Claude login for each profile

The Anthropic Subscription provider serves Claude models through the Claude engine that ships with Flywheel, which runs and keeps each Claude sign-in. Flywheel never reads, stores, or sends a Claude sign-in token except under PI-MODEL-082, and never reads, uses, or changes a Claude login that it did not create. Each Claude login belongs to one Flywheel profile, so a new profile has no Claude account and Disconnect logs it out of that profile only. A profile in a separate Flywheel home of the same computer account can use such a login by reference, and Disconnect there removes only the reference.

## PI-MODEL-082: A headless run can use a Claude token

A headless run on a machine with no Claude login can use a long-lived token that the person makes with the Claude setup-token command. Flywheel carries the token only in that run's one-use auth snapshot and gives it only to the Claude engine. No shell command of the agent inherits it, and no log or stored session holds it. A command of the same OS user can still read the engine's startup environment, so the trial sandbox and the token's lifetime are its boundary.

## PI-MODEL-070: Anthropic Subscription is an ordinary provider that is on by default

Every surface that names the provider, such as Authentication, Settings, Doctor, notices, and the auth command, calls it Anthropic Subscription. The provider is on by default, needs no install, and turns off and on from an ordinary Settings row that asks nothing. The engine never updates itself or downloads anything, so a new engine comes only with a new Flywheel release. When enabled and eligible, this provider is the first provider route for Claude models, within account availability, included-capacity ordering, and paid-use consent.

## PI-MODEL-071: Flywheel's Claude engine and the person's own install never interact

The provider works the same whether or not the person has a separate install of the Claude engine, and it never uses that install. Flywheel's engine reads and writes nothing that belongs to the person's install or to the project's Claude configuration, such as settings, logins, hooks, instruction files, caches, or logs. Neither engine sees or signals the other's processes, and the person's install finds nothing of Flywheel's engine. The machine's Claude policy, which an administrator sets for every Claude install on the machine, applies to both.

## PI-MODEL-072: A Claude login shows its sign-in page, its account, and its state

In every client, a Claude browser login shows the sign-in page and a field for the code that the page shows. Each account row shows the account's email address and, when the engine names it, its plan. When the engine cannot read an account's login and has sent no request, Flywheel sends the same request once more on a fresh engine, and the person sees nothing. When Claude refuses an account's login, or a fresh engine also cannot read it, the row says so and one notice says the same.

## PI-MODEL-073: A failed Claude engine is reported once and recovers

When the engine exits while it serves a request, the row and one notice say so, and Flywheel starts the engine again for the next request. When the engine cannot start on this machine, the request goes to the next route at once. The row and one notice then say that the engine cannot start and how to repair the installation. A request that the account then serves clears the row and the notice.

## PI-MODEL-074: A refused Claude login asks once in each project to log in again

When Claude refuses an account's login, every interactive run, workflow agent, and subagent that needs the account waits, and every client asks once in each project: "Log in again?" The question names the account and profile and says that this project's runs wait and that declining ends them. Yes starts that account's login, and a successful login to the same account continues this project's waiting runs with the exact request that failed. No, closing the question, a failed or cancelled login, or a login to a different account ends the waiting runs with their original login error.

## PI-MODEL-075: A refused Claude login never moves to another account

Flywheel never retries a waiting run's request under a different account. Later runs that meet the same refusal end with the login error without another question, until a successful login or a served request on that account clears the condition in their project. Headless tasks and stdin/stdout chat fail at once with the login error instead of waiting or asking.

## PI-MODEL-076: Each project waits for a refused Claude login on its own

The login question and the runs that wait for it belong to one project. A login in one project continues another project's waiting runs only after that project's question is answered or its next request on that account is served. Stop ends one waiting run at once and leaves the other runs that wait for the account.

## PI-MODEL-077: Doctor reports the Claude engine and each login

The doctor command reports where the engine is, the version that the engine states, and each account with its plan, its status, and how its last request in this process ended. For each account it names the login folder and where the engine keeps the token, and a login folder that serves no account says what it holds. The doctor command never reads a token or a credential file. An engine that does not run asks the person to reinstall Flywheel, and a Linux login without a token asks the person to log in again.

## PI-MODEL-078: Claude extra usage pauses an account while paid use is off

A Claude usage-only enterprise account uses its normal metered billing without a paid-use question. For an account with included usage, Flywheel asks the paid-use question when the engine records that extra usage can bill the account. While paid use is off, Flywheel keeps the answer of a request that extra usage served, or that included usage did not visibly serve, and then stops using that account. It holds the account until its included usage resets, or for a few minutes when no reset is known, and one notice names the account and says where to allow paid use.

## PI-MODEL-079: The Claude engine keeps Flywheel's tools, text, and effort

The Anthropic Subscription provider keeps Flywheel's tool capabilities, tool execution, and the person's message text unchanged. A request at reasoning effort off uses the model's own off mode, as on the Anthropic API-key provider.

## PI-MODEL-080: Claude routes give the model the same environment facts

At the start of each conversation context, the Anthropic Subscription and API-key providers give the model hidden reminders of the working directory, git state, platform, shell, operating-system version, model, knowledge cutoff, and local date. Later reminders state each change of working directory, git state, model, or local date. On every route, the system prompt states the turn's start date, and the local date matches the Claude engine's, in the TZ setting's zone on macOS and Linux and the system zone on Windows. Each engine request states the environment once, also after rotation and at each hosted agent dispatch.

## PI-MODEL-081: Context text from the Claude engine stays hidden history

Reminders stay in model history but hidden from the transcript. They survive resume and forks, reset with the active context, and stay across a provider switch. On a Claude login the engine also gives the model the account's email address, which Flywheel does not record and the API-key provider never sends. A shared Claude engine also gives each agent the engine's identity line, agent instructions, environment, and resume lines, which Flywheel records hidden in that agent's history. On Windows with Git for Windows, the engine names the shell bash, but Flywheel's shell tool description, which says PowerShell, is the authority.

## PI-MODEL-028: A workflow file can set each agent's model

A workflow file can fix the model, the effort, or both for each of its agents. The run keeps only those fixed fields. Fields that the file does not fix follow the current settings of the run's auth profile, also after Resume. Model availability or an unsupported effort never refuses a launch, and a fixed effort stays in force when its model is unreachable.

## PI-MODEL-040: A workflow agent's own settings come first when its model resolves

Each request from a workflow agent resolves its model and effort from its session's settings and the current settings of the run's auth profile. The narrowest saved session setting wins as a whole, then the profile's persona or Workflow Agent setting, then the role's coded preferences and tier. A setting that names only an effort keeps the default model. The chat that launches a workflow never chooses an agent's model.

## PI-MODEL-041: Briefs have no model defaults

The default model picker does not list briefs. A defaults save to a brief is refused with guidance to set the Workflow Agent default or the agent's own session setting. Profile settings saved earlier for a brief stay saved but never apply, and Flywheel warns about them. The Workflow Agent picker saves to the profile and has no Inherit row.

## PI-MODEL-042: A model change in a workflow reaches only the sessions that inherit it

An edit or a choice of inheritance in an agent's view changes only that agent's session, and only the fields that the workflow file did not fix. A workflow-wide change reaches only unfixed fields, in sessions that still inherit the workflow's choice. Resume and recovery keep an agent's own choice, and a fresh retry or round uses the workflow's current choice. Resetting the workflow's choice keeps the fixed fields and does not remove an agent's own override.

## PI-MODEL-043: Workflow surfaces show each agent's effective model

The workflow card, the workflow view, and each agent view show each agent's current effective model and effort. An edit in an agent view updates that agent's card row at once. The model picker marks the fields that the workflow file fixed. A launch reports each agent's current selection, or that no model is reachable or that access is still being checked.

## PI-MODEL-029: An agent can list the models its session can use

An agent can list the models that its session can use now under the active profile, with each model's provider, release date, knowledge cutoff, prices, supported efforts, and tier role. For first-party models released in the last six months, the list also gives quality, speed, and cost tiers from 1 to 10 for each effort. Flywheel derives these tiers from current public benchmark data, so a new model can gain tiers without a Flywheel update. The list never shows raw benchmark scores, and asking for it never changes the cached prompt prefix.

## PI-MODEL-030: The Benchmark Judge setting is listed only with development tools

The model settings list the Benchmark Judge role only while the development module is on. A model set for that role stays saved while the module is off or absent, and applies again when it is back on.

## PI-MODEL-031: A refusal of conversation content does not end the run

Each time a provider refuses content in the conversation that Flywheel has not yet withheld, Flywheel withholds it from the model, tells the model and the person what it withheld and why, and continues. When Flywheel cannot find the refused content, it removes the latest tool calls and their results, tells the model not to run them again, and tries once more. If the provider still refuses, the run ends with the provider's error. Withheld or removed content stays withheld for every later request on every provider, and a resumed session that already holds refused content recovers the same way.

## PI-MODEL-032: The environment and the project select the auth profile

Flywheel uses the auth profile that the auth profile environment setting names, by exact ID or else by a unique case-insensitive display name. Otherwise it uses the current project's bound profile, then the last profile the person chose, then Default. A profile named by the environment applies to that process only and never changes a saved choice. While the environment names the profile, that process cannot switch to another profile or delete the named one. A project's profile binding is private to the person's account and is never stored in the project.

## PI-MODEL-033: A session keeps the auth profile it uses

Each session keeps the auth profile it started with until the person switches that session to another profile. Changing the default profile, or launching with a different profile in the environment, does not change a saved session's profile or its model roles. Switching a session's profile applies that profile's models to the session at once. Work already in progress finishes with the profile, credentials, and model access it started with.

## PI-MODEL-034: Sign-in from any client signs in the machine that runs the runtime

Signing in, disconnecting, or renaming an account from any client changes the attached runtime's accounts, never those of the person's device. A terminal on the runtime's machine opens each sign-in page there, so a sign-in that returns to the machine needs no pasted code. A terminal or phone attached through the relay shows the sign-in address to open in the person's own browser. When the sign-in returns to the machine, that client also takes the code or final address the page ends on. For a device-code sign-in, it shows the code that the person enters on the provider's page.

## PI-MODEL-035: An API key for another provider is refused

When a person enters an API key for a provider whose keys carry a known prefix, and the key carries another installed provider's prefix, Flywheel refuses it. The refusal names the provider that the key belongs to. A key with no known prefix is accepted, and a provider whose keys carry no known prefix accepts any key.

## PI-MODEL-036: Custom OpenAI-compatible providers come from configuration

Declaring a custom OpenAI-compatible chat-completions provider in the configuration file, with its endpoint, its complete model list, and an optional models.dev identity, turns it on with no module toggle or Settings row. The person adds its API key in Authentication, where the provider appears under the entry's id. An edit to the file reaches Authentication and new sessions without a restart, while an open session keeps the providers it started with. An entry that fails a semantic check, such as an invalid id or non-HTTP address, stays visible in Authentication as misconfigured, with the reason, for the person to fix.

## PI-MODEL-037: The automatic sign-in dialog never interrupts another dialog

When no provider is set up, the terminal opens Authentication on its own once each time it starts, and only when no other dialog is open. It checks again first and does not open when a provider was set up meanwhile. A message sent while no provider is set up is not sent: the terminal says why and opens Authentication. Authentication opened by hand always shows a fresh view.

## PI-MODEL-038: Free-plan accounts never rotate

Only paid subscription accounts rotate, and a free-plan account serves only while it is the only account of its provider in the profile. An account is free-plan only when its provider reports a free plan, such as ChatGPT Free or Copilot Free, and SuperGrok and Claude subscriptions always count as paid. A free-plan account beside another account of its provider stays connected but does not serve until it is the only one or its plan becomes paid, and Flywheel tells the person once. Its account row says why and offers to disconnect it.

## PI-MODEL-069: Sign-in keeps one free-plan account per provider

On every client and in the auth login command, Flywheel refuses a free-plan sign-in when the profile already holds an account of that provider, stores nothing, and says why. When Flywheel cannot read the plan of a new account in that case, it refuses the account the same way and says to try again later. A paid sign-in beside a free-plan account of its provider first asks: "This will replace your attached free subscription because we only allow multiple copies of paid subscriptions." Confirming stores the paid account and disconnects every free-plan account of that provider, and declining stores nothing.

## PI-MODEL-039: Every agent waits out spent capacity and continues

When no candidate can serve an agent until a stated time, such as a usage-limit reset, the agent waits until that time and continues its turn on its own. This holds for a chat, a workflow agent, a subagent, and a headless task. If every candidate is still spent then, the agent waits again. A spent candidate that states no time is checked again after a short interval. A wait that the runtime serves continues across a restart, an unexpected exit, a reboot, or sleep, also when no client shows the session, and reopens its project if it closed.

## PI-MODEL-063: Capacity wait status and end

While an agent waits for model capacity, every client shows "Waiting for model capacity" with the agent's name and the time it continues, also after a restart. An interrupt or a Stop ends the wait, and a message from the person starts a turn at once. A headless task waits only while its own process runs, and its own deadline also ends its wait.
