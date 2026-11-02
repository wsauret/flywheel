## Review and undo

Because Flywheel writes directly, the important surface is what happened rather
than what is proposed.

Every file it changed appears under **Changes** in the Flywheel panel, each with a real diff against how the file looked before this session started. Click a file's header to expand the whole diff.

Nothing is one-way. **Undo** puts a file back, and it refuses rather than forces: if you edited the file yourself after Flywheel wrote it, it leaves your work alone and tells you so.
