# Local Access Product Intent

This document states the current intended experience for reaching a Flywheel runtime from a browser on the machine that runs it.

## PI-LOCAL-001: One command opens the project in the browser

A user opens a project's sessions in their own browser with one command on the machine, and sees the same web client the editor and phone show, attached to the same live runtime the terminal and editor use. The command starts the project's runtime when none is serving.

## PI-LOCAL-002: The page is reachable only from that machine, through the project's own link

The runtime listens for the browser on the loopback address alone. A project has one link, the same on every start, and only a page opened through that link can connect; a page from any other site or origin cannot. A browser that opened the link once reaches the project again from a bookmark, a new tab, a reload, or a tab left open across a runtime restart, without running the command again. A page that has no way in, because its browser never opened the link or the link no longer opens the project, says so and names the command that opens the project with a fresh link. Opening the link of a known project that is asleep starts the project, and the page says it is starting until the project serves. A project that failed to open shows the cause and a link to the project list, and does not start again. Two known projects never share a link.

## PI-LOCAL-003: The browser tab names the session and shows its state

In the browser, the tab's title names the selected session and says up front when that session is working or when the page has lost the runtime, and the tab's icon is Flywheel's tile, marked while the session works and dimmed while the runtime is lost. The page can be installed from the browser as an app with that name and icon.

## PI-LOCAL-004: The page's address names the session

In the browser, the address names the session in view, so a reload, a bookmark, or a link opens that session, even a subagent or workflow agent that the session list does not show, and the back button returns to the one before. A reload also returns to the reader's place in the session. Only when the runtime says that the named session no longer exists does the page open the project's usual first session, correct the address, and say so in a notice.

## PI-LOCAL-005: One fixed local address reaches every open project

A machine has one fixed local address that lists every known project as open or asleep, opens an open project, and starts an asleep project before opening it. The list tells a starting project from a closing one. When an open project's browser page cannot start, the list shows the cause and a Retry control, and the project stays usable from the terminal and editor. While an asleep project starts, the page keeps Flywheel's visual theme and shows the animated Flywheel tile with the project name. With exactly one known project, the address opens or starts it directly. When that project failed to start, the address retries it once, and when the retry fails too, the address shows the list with the cause and a Retry control. With no known project, the address says how to open one. The list removes an asleep or failed project on request, so no surface offers it again until the machine opens it. The list page shows Flywheel's tile as its icon, so a bookmark of it carries the same icon as a project page.
