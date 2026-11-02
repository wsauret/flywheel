---
expected_files:
  - cli.py
  - store.py
test_command: python3 -m unittest discover -s tests -v
---
Build a Python CLI todo app. cli.py uses argparse with subcommands: add, list, complete, delete. store.py handles persistence via sqlite3 (todos.db). Each todo has id (int, autoincrement primary key), text (str, not null), done (bool, default false). tests/ with unittest covers all subcommands and edge cases (empty list, delete nonexistent, complete already done). Stdlib only.
