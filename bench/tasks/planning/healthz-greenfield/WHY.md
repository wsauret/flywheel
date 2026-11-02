# Why this task exists

This task is the small greenfield control. It tests whether a model can produce a direct implementation plan when repository research is not useful. The brief has one HTTP behavior, one build value, and one test requirement.

There is no manifest because the sandbox has no existing source contract to discover. The brief asks for a new Express service, so the sandbox is greenfield: the loader maps `"greenfield"` to the empty Git tree, and the Chat starts in an empty repository whose only file is the `.gitignore` that every sandbox gets. The plan must establish its own Express and Vitest structure. Recall is not scored for this task, and the pairwise judge reads "None: the repository is empty" as its known requirements.

## Verification at the pinned tree

The pinned tree is the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, so the brief can make no claim about existing code. A minimal Node HTTP fixture was considered as the starting point and rejected, because it is not an Express service.
