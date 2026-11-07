# Groups JSON

The input finalize.sh takes through the skill tool's child-run action. Freeze it in a session note before asking for approval, then pass exactly the frozen object.

```json
{
  "base": "<full merge-base hash>",
  "trunk": "main",
  "final_tree": "<full hash of current HEAD>",
  "goal": "short-slug",
  "groups": [
    {
      "title": "Switch to forks pool",
      "body": "Why + what changed.\n\nExperiments: #3, #5\nMetric: total_time 42.3s to 38.1s (-9.9%)",
      "last_commit": "<full hash of last kept commit in this group>",
      "slug": "forks-pool"
    }
  ]
}
```

Rules the script enforces:

- Every hash is a full 40-character hash. Expand recorded short hashes with `git rev-parse`.
- `last_commit` is the last kept commit of the group in application order; groups are applied to the merge-base in list order.
- No two groups may share a file. The script validates this and fails naming the file.
- Each group becomes one branch named `experiment/<goal>/<n>-<slug>` from `base`, and the union of all branches must reproduce `final_tree` outside `.experiment/`.
