# Lead Product Intent

This document states the current intended experience for the lead chat that starts and routes a project's other chats.

## PI-LEAD-001: The lead receives the person's requests

While the lead capability is on, each project has one lead chat. A terminal launch with no earlier tabs to restore opens the lead as its only tab. A launch that restores earlier tabs keeps them and adds the lead as the first tab. The person sends each request to the lead. The lead answers a short question itself, and for that it can read the project's files, the web, and the progress of the chats that it started. It gives every other request to a chat. The lead never changes files, runs commands, or starts subagents or workflows.

## PI-LEAD-002: A routed request keeps the person's words

The lead gives a request to a new chat, or to a chat that it started earlier when the request belongs to that chat's work, and tells the person which. The chat receives the person's message unchanged, with its attachments, as a message from the person. The lead can add a note of its own, which the chat shows as a message from the lead. The lead never rewrites a request.

## PI-LEAD-003: A chat that the lead started is an ordinary chat without a tab

A chat that the lead started opens no tab and is otherwise an ordinary chat. It works while no client shows it, asks the person its own questions, and owns its own changes review and background list. Session navigation lists it like every chat. The person can open it as a tab, message it, interrupt it, close it, or delete it.

## PI-LEAD-004: The lead's screen lists the chats that need attention

In the terminal, the lead's screen lists each chat that the lead started and that needs the person, is working, or holds a result that the person has not read. A row shows the chat's state as a mark and a word, its title, its latest update in its own words, and its age. Chats that need the person come first, the longest wait first. A row changes only when its chat posts an update or changes state. Every terminal view shows how many chats need the person.

## PI-LEAD-005: The person decides from the lead's screen

From the list, the person opens a chat's pending question, failure, or unread result in place, in the chat's own words, without opening the chat. An answer goes directly to the chat that asked. Escape closes a question and leaves it pending, and a separate action skips it. One key opens the item that has waited longest. A question never opens on its own and never interrupts typing. Reading a result marks it as read.

## PI-LEAD-006: The lead comments and never speaks for a chat

The lead learns when a chat that it started asks the person a question, finishes a turn, fails, or is cut. It can then add its own comment or recommendation in its transcript. It never rewords, replaces, or answers a chat's question or report. It starts or routes work only at the person's request, never in response to a chat.

## PI-LEAD-007: Every chat is one step from the lead

From a row, the person peeks at a chat: its request, its latest updates, its changed files, and an input that sends the person's message to that chat. The person also opens the chat's full conversation over the lead, to read it, type in it, answer its question, and move to the next chat. Escape returns to the lead. One action opens the chat as a tab.

## PI-LEAD-008: Working without the lead stays possible

The person can start chats and open tabs directly, as without a lead. Closing the lead's tab asks for confirmation, and the chats that it started keep working. The project then opens on ordinary tabs until the lead command opens the lead again. Turning the lead capability off removes the lead's tab, list, and tool, and keeps every chat.
