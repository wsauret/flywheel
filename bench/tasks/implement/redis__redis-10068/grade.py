from __future__ import annotations

import ast
import json
import pathlib
import re
import sys
import types
import typing


def main():
    """Load pinned original AST nodes and grade one completed evaluation log."""
    task, log, patch, output = map(pathlib.Path, sys.argv[1:])
    original = task / "original"
    namespace = {"re": re, "Any": typing.Any}
    exec(compile((original / "sources/__init__.py").read_text(), "constants", "exec"), namespace)
    exec(compile((original / "sources/infra_failure.py").read_text(), "infra_failure", "exec"), namespace)
    names = {
        "parse_log_redis", "parse_test_exit_code", "_resolve_case",
        "test_passed", "test_maintained", "test_failed", "get_logs_eval",
        "get_eval_tests_report", "compute_fail_to_pass", "compute_pass_to_pass",
        "get_resolution_status", "get_eval_report",
    }
    assignments = {"SUITE_RAN", "TEST_EXIT_CODE_RE"}
    loaded = set()
    for filename in ["c.py", "grading.py"]:
        tree = ast.parse((original / "sources" / filename).read_text())
        nodes = []
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name in names:
                nodes.append(node)
                loaded.add(node.name)
            elif isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id in assignments for target in node.targets
            ):
                nodes.append(node)
        exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, "exec",
                     flags=__import__("__future__").annotations.compiler_flag), namespace)
    assert loaded == names
    namespace["PARSER_REGISTRY"] = {"parse_log_redis": namespace["parse_log_redis"]}
    row = json.loads((original / "row.json").read_text())
    spec = types.SimpleNamespace(**row)
    statuses, found = namespace["get_logs_eval"](spec, str(log))
    original_report = namespace["get_eval_report"](
        spec, {"instance_id": row["instance_id"], "model_patch": patch.read_text()}, str(log), True
    )
    tests = namespace["get_eval_tests_report"](
        statuses, row, eval_type=namespace["EvalType"](row["eval_type"])
    )
    result = {
        "report": original_report,
        "tests": tests,
        "resolution": namespace["get_resolution_status"](tests),
        "found": found,
        "selected_statuses": {key: statuses.get(key) for key in row["FAIL_TO_PASS"] + row["PASS_TO_PASS"]},
        "all_statuses": statuses,
    }
    output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
