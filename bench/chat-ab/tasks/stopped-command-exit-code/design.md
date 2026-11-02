When I stop a background command, its row says "Stopped · exit 1", and the agent hears "exited with code unknown". Fix the outcome reporting, not just the wording. A signal must not give a command an exit code it never had.

The command owner must distinguish an observed exit code, an observed signal termination, and an end whose outcome nobody observed. Carry that distinction through background tracking and recorded results, including commands that survive a runtime restart or change owners. Record an observed signal termination without an exit code. Keep an unobserved outcome unrecorded. Tell the agent which signal ended the command when the platform supplies it; otherwise say that a signal ended it. Only use launch-failure stderr explanations for exits with a real code.

Keep stop intent separate from the process outcome. A command I stop must remain stopped; a signal that ends a command without my stop must count as failure. Commands that exit on their own must keep their real exit code, with zero meaning success.

The shared background-row presentation must hide exit codes for stopped or canceled commands while keeping their status and duration. Apply that rule in both clients and to older records, even when a trapped signal or Windows termination produced a numeric code. Do not rewrite those records to fix their display.

Implement this and run the relevant tests. Cover requested stops, unsolicited signals, ordinary exits, and stopped or canceled rows that already contain exit codes.
