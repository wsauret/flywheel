When I press Stop on one chat, sometimes every other running chat in the same project stops mid-turn too. Their turns just end, and I have to resume each one by hand.

It seems to happen when the account service briefly loses its connection to the project's backend at the moment I press Stop. The connection comes back within a second or so, and the backend process itself never died.

Stopping one session must stop only that session. If the backend really does not come back in time, it is fine for the stop to force its way through, but a short connection blip should not take every other session down with it.
