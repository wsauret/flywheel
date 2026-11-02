A subagent asked its parent a question. The parent asked me in the chat and ended its turn while the subagent still ran. The subagent then tried to wait without sending more text, but Flywheel refused it as a cycle. It sent the question again, so the parent now has it twice.

Make the session messaging layer decide cycles from open reply waits only, including chains through other sessions. Pausing on running children does not itself create a reply wait. My input or another child's completion can wake the parent. Remove the tracking of parents paused on children from this decision, rather than adding a special exception for this case. Keep refusing a wait without text when it would close a direct or indirect cycle of reply waits.

Keep the existing rules for ending waits. Once the parent has read the question, ending its turn or pausing on children still ends the first wait with its last words. The child can then wait again without sending another message. Show that the child waits on its parent. The parent's later reply must end that wait once, without an extra notification.

Work out the implementation details and run the relevant tests. Cover the parent paused with a child still running, the second wait without another message, and direct and longer reply-wait cycles.
