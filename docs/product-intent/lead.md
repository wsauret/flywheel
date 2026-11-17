# Lead Product Intent

This document states the current intended experience for the lead chat that starts and routes a project's other chats.

## PI-LEAD-001: The lead receives the person's requests

While the lead capability is on, each project has one lead chat. A terminal launch with no earlier tabs to restore opens the lead as its only tab. A launch that restores earlier tabs keeps them and adds the lead as the first tab. The person sends each request to the lead. The lead answers a short question itself, and for that it reads the project's files, the web, its chats' progress, and a search of every past chat. It gives every other request to a chat. The lead never changes files, runs commands, or starts subagents or workflows.

## PI-LEAD-002: A routed request keeps the person's words

The lead gives a request to a new chat, or to any chat of the project whose work the request continues, also one that left the list. That chat joins the list. It receives the person's message unchanged, with its attachments, as a message from the person. The lead can add a note, which the chat shows as from the lead. A message that asks for several separate pieces of work is split: each chat receives only the passages that its work needs, word for word. The lead never rewrites a request.

## PI-LEAD-003: A chat that the lead started is an ordinary chat without a tab

A chat that the lead started opens no tab and is otherwise an ordinary chat. It works while no client shows it, asks the person its own questions, and owns its changes review and background list. Session navigation lists it. The person can open it as a tab, message it, interrupt it, close it, or delete it.

## PI-LEAD-004: The lead's screen lists every chat that works or needs the person

In the terminal, the lead's screen lists below its input every chat of the project that works or needs the person, from any starter or client. It excludes the lead and the subagents and workflow agents of a chat. A chat leaves the list by itself once it is idle with nothing unseen, and returns when it works or needs the person again. A restart keeps only chats that need the person. Each row names its chat by its tab title, then its longer title.

## PI-LEAD-005: The person answers and opens chats from the lead's screen

A listed chat's question enters the lead's transcript as a widget in the chat's own words with every option. The person answers or skips it there by key or click. Several can wait. A widget never takes focus by itself. A question settled anywhere shows its answer. Enter or a click on a list row opens the chat over the lead as in its tab, without tab keys. Escape interrupts a running turn, or else returns to the lead, with focus where it was. A shown result is read, and opening a failed or cut chat marks that state seen.

## PI-LEAD-006: The lead summarizes reports and never speaks for a chat

The lead learns each question and milestone message of a listed chat, and when one that no client shows finishes a turn, fails, or is cut. A report or milestone shows in its transcript as a line that names the chat and opens it there. A shown report and a turn that ends while a client shows the chat count as read. The lead summarizes a report. After a question it adds at most a short recommendation and never restates it. It never answers a chat's question, never replies to a chat, and routes work only at the person's request.

## PI-LEAD-007: Every chat is one step from the lead

In a chat's conversation over the lead, the person reads it, types in it, changes its model, answers its question, and moves to the next or previous chat. One action, from the list or from the conversation, opens the chat as a tab.

## PI-LEAD-008: Working without the lead stays possible

The person can start chats and open tabs directly, as without a lead. Closing the lead's tab asks for confirmation, and the chats that it started keep working. The project then opens on ordinary tabs until the lead command opens the lead again. Turning the lead capability off removes the lead's tab, list, and tool, and keeps every chat.

## PI-LEAD-009: The lead's tab names the project

While the lead's tab is in front, the terminal title names Flywheel and the project, such as "Flywheel | Data", because the lead is the project's own screen. Every other tab keeps its chat's title.

## PI-LEAD-010: The Sessions list opens chats over the lead

The Sessions list does not show the lead, because the lead is always the first tab and the lead command reopens it. While the lead's tab is in front, choosing a chat in the Sessions list opens it over the lead, and the open-as-tab action opens it as a tab. On every other tab, the Sessions list works as without a lead.

## PI-LEAD-011: The lead speaks as the person's assistant

The lead speaks as the person's assistant, and its own words lead its transcript. It writes nothing before or between its calls. After its calls, it says in one short sentence what it did, such as "I resumed the session that did that work and passed your message to it." The lead and its screen call every other conversation a session. A reply that clearly concerns one session's report or question goes to that session with no line. The lead never tells the person to reply in a session. In the terminal, its calls gather under headings (PI-LEAD-017).

## PI-LEAD-012: Every chat reports in one shape

While the lead is on, every new chat, and an older chat once the lead gives it a request, writes each question for a reader new to the chat. It ends each turn with a report of its status: done, waiting on the person's yes, or stopped on a question. It then states what changed, what it verified and how, what waits on the person, open questions with a recommendation, and what it noticed. Every listed chat messages the lead mid-turn at each milestone, such as a PR opened. The lead's summary presents the chat's findings as the chat's claims.

## PI-LEAD-013: The lead's tab shows only beside other tabs

While the lead's tab is the only tab, the terminal tab bar shows no tab and no new-tab control, only the stats and an unbroken divider line, because one tab needs no tab bar. When another tab opens, the lead's tab appears at once as the first tab, to the left of the new one. It hides again when the lead's tab is the only tab again. The new-tab key still opens a tab while the bar is empty. An ordinary chat that is the only tab keeps its tab as without a lead.

## PI-LEAD-014: The lead's tab does not teach tabs

While the lead's tab is in front, the composer's placeholder and border show no new-tab, close-tab, or tab-switch hint, because the lead is the happy path and tabs are the divergent one. Those keys still work. The Sessions hint stays, because the Sessions list opens chats over the lead.

## PI-LEAD-015: A row shows the chat's state

A row in the lead's list shows the chat's state as a mark, its title, one short line of status, and its age. The status of a working chat names its newest action as its transcript summarizes it. A question or a result shows its own first line. A failure or a cut shows until the person sees it. Chats that need the person come first, the longest wait first. Every terminal view shows how many chats need the person.

## PI-LEAD-016: The person closes a chat from the lead's screen

The x key on a selected row of the lead's list closes the chat. A click on the close mark of the row under the pointer does the same, and so does the close action of the chat's conversation over the lead. Each closes the chat as Close chat does: its work ends now, and a tab that shows it closes. The chat leaves the list at once, also while it works.

## PI-LEAD-017: The lead's calls gather under headings

In the terminal, the lead's words never fold. Its calls between one message and the next gather, indented, under one muted heading with the time, the duration, and what it did with its chats. While the calls run, the heading is open and says the lead is working. It closes once a message follows or the turn ends, and a click opens or closes it. Bookkeeping calls never show, and no divider line separates its words from its calls.

## PI-LEAD-018: The lead never leaves a request unrouted

The lead routes every request in the turn that it arrives in, also a question that its own reading cannot fully answer, such as the state of a PR or of earlier work. It never offers to route a request instead. A request that continues earlier work goes to the chat that did that work, which the lead finds by search. Only when no past chat fits does a new chat start.

## PI-LEAD-019: The lead reads how each chat stands

When the person asks how the chats go, the lead reads each chat in its list and summarizes from what it read, because a list row alone does not tell. For one chat, the lead reads where the chat's checkpoint says it stands and its next step. It also reads the person's messages and the chat's replies, newest first and earlier on request, without tool output. It reads the chat's subagents and workflows that have not finished, with their goal, state, and time, and the chat's newest calls.
