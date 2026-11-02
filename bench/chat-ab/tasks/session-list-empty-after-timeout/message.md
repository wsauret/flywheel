If a project is slow to open (for example, a big store where the first history read takes too long), the session list stays empty for the whole life of the project. Sessions that I create or rename afterwards do not show up either.

The only way to get the list back is to restart the account service. One slow read during startup must not leave the list empty forever. The list must recover on the next request or the next session change, and it must not lose the changes that happened while it was broken.
