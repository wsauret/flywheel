import json
import os
import signal
import sqlite3
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from .harbor_agent.flywheel_harbor_agent import shim
except ImportError:
    from harbor_agent.flywheel_harbor_agent import shim

SNAPSHOT = {
    "profile": "benchmark",
    "credentials": {"openai_api": {"type": "api_key", "key": "sk-test-" + "k" * 40}},
    "modelAccess": [],
}


def _store(project: Path, value: str) -> None:
    flywheel = project / ".flywheel"
    flywheel.mkdir(mode=0o700, parents=True)
    connection = sqlite3.connect(flywheel / "flywheel.sqlite")
    connection.execute("create table event (payload text)")
    connection.execute("insert into event values (?)", (value,))
    connection.commit()
    connection.close()


def _bun(directory: Path) -> Path:
    """A `bun` that runs its script with this Python, so a test analysis can stand in for the packaged one."""
    bun = directory / "bun"
    bun.write_text(f"#!/bin/sh\nexec {sys.executable} \"$@\"\n")
    bun.chmod(0o755)
    return bun


def _analyzer(directory: Path) -> Path:
    """An analysis that states the identity of the store it read, as the packaged one does, and nothing of its content."""
    analyzer = directory / "analyzer.py"
    analyzer.write_text(
        "import hashlib, json, os, sys\n"
        "payload = open(sys.argv[1], 'rb').read()\n"
        f"print(json.dumps({{'version': 1, 'store': {{'sha256': hashlib.sha256(payload).hexdigest(), 'size': len(payload)}}}}))\n"
    )
    return analyzer


class TakeSnapshotTest(unittest.TestCase):
    def test_moves_the_snapshot_out_of_the_environment_into_a_private_stage(self) -> None:
        environ = {shim.SNAPSHOT_ENV: json.dumps(SNAPSHOT), "KEEP": "1"}
        stage_file, profile = shim.take_snapshot(environ)
        try:
            self.assertEqual(environ, {"KEEP": "1"})
            self.assertEqual(profile, "benchmark")
            self.assertEqual(stage_file.name, "auth.json")
            self.assertTrue(stage_file.parent.name.startswith("flywheel-auth-bundle-"))
            self.assertEqual(stat.S_IMODE(stage_file.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(stage_file.stat().st_mode), 0o600)
            self.assertEqual(json.loads(stage_file.read_text()), SNAPSHOT)
        finally:
            stage_file.unlink()
            stage_file.parent.rmdir()

    def test_refuses_a_missing_snapshot(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "FLYWHEEL_AUTH_SNAPSHOT is unset"):
            shim.take_snapshot({})

    def test_the_child_environment_carries_no_snapshot(self) -> None:
        shim_bin = str(Path(sys.executable).parent)
        environment = shim.child_environment({shim.SNAPSHOT_ENV: "x", shim.PROFILE_SHA256_ENV: "y", "TASK_VAR": "z", "PATH": f"{shim_bin}:/opt/task/bin:/usr/bin"}, Path("/home"), Path("/bun/bin"), Path("/app"), "d" * 64)
        self.assertNotIn(shim.SNAPSHOT_ENV, environment)
        self.assertNotIn(shim.PROFILE_SHA256_ENV, environment)
        self.assertEqual(environment["TASK_VAR"], "z")
        self.assertEqual(environment["FLYWHEEL_PROJECT_ROOT"], "/app")
        # The task image's PATH stays; only the shim's own virtual environment leaves it.
        self.assertEqual(environment["PATH"], "/bun/bin:/opt/task/bin:/usr/bin")


class ExportEvidenceTest(unittest.TestCase):
    def test_records_the_analysis_of_the_settled_store_and_never_the_store(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            logs = root / "logs"
            logs.mkdir()
            publication, withheld = shim.export_evidence(root / "project", logs, _bun(root), _analyzer(root))
            self.assertIsNone(withheld)
            self.assertEqual(sorted(path.name for path in logs.iterdir()), [shim.ANALYSIS_NAME])
            self.assertEqual(json.loads((logs / shim.ANALYSIS_NAME).read_text())["store"], {"sha256": publication.sha256, "size": publication.size})

    def test_records_nothing_when_the_analysis_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            logs = root / "logs"
            logs.mkdir()
            failing = root / "failing.py"
            failing.write_text("import sys; sys.exit(3)\n")
            self.assertEqual(shim.export_evidence(root / "project", logs, _bun(root), failing), (None, "analysis_failed:exit_3"))
            self.assertEqual(list(logs.iterdir()), [])


class RunShutdownTest(unittest.TestCase):
    """Drives `shim.run` with a stub child, as Flywheel behaves when Harbor closes stdin or sends SIGTERM."""

    def _run(self, root: Path, export_command: list[str] | None = None, child_code: str = "pass", export_budget: float = 0.5) -> tuple[int, dict, float]:
        project, logs = root / "project", root / "logs"
        logs.mkdir()
        tools = root / "tools"
        tools.mkdir()
        _bun(tools)
        analyzer = _analyzer(tools)
        stubs = [
            patch.object(shim, "read_build_record", lambda _root: {"build_id": "b" * 12, "flywheel_source": {"commit": "c" * 40}, "runtime_archive": {"path": "archive", "sha256": "d" * 64}, "flywheel_config": {"path": "config"}, "store_analyzer": {}}),
            patch.object(shim, "_install_bun", lambda _work: tools),
            patch.object(shim, "_install_runtime", lambda work, _archive, _bin: work),
            patch.object(shim, "_install_store_analyzer", lambda _runtime, _root, _entry: analyzer),
            patch.object(shim, "_install_home", lambda work, _config, _profile: work / "home"),
            patch.object(shim, "_child_command", lambda *_: [sys.executable, "-c", child_code]),
            patch.object(shim, "_EXPORT_BUDGET_SECONDS", export_budget),
        ]
        self.addCleanup(signal.signal, signal.SIGTERM, signal.getsignal(signal.SIGTERM))
        if export_command is not None:
            stubs.append(patch.object(shim, "_export_command", lambda: export_command))
        for stub in stubs:
            stub.start()
            self.addCleanup(stub.stop)
        started = time.monotonic()
        status = shim.run({shim.SNAPSHOT_ENV: json.dumps(SNAPSHOT)}, project, logs, root)
        elapsed = time.monotonic() - started
        return status, json.loads((logs / "flywheel-run-summary.json").read_text()), elapsed

    def _sigterm_after(self, delay: float) -> None:
        sender = threading.Timer(delay, os.kill, (os.getpid(), signal.SIGTERM))
        sender.start()
        self.addCleanup(sender.cancel)

    def test_records_the_store_analysis_through_the_export_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            status, summary, _ = self._run(root, export_budget=5)
            analysis = json.loads((root / "logs" / shim.ANALYSIS_NAME).read_text())
            self.assertEqual(status, 0)
            self.assertNotIn("evidence_withheld", summary)
            self.assertEqual(summary["adapter_settlement"], "normal")
            self.assertEqual(summary["evidence_sha256"], analysis["store"]["sha256"])
            self.assertFalse((root / "logs" / "state").exists())

    def test_a_slow_export_is_cut_at_its_deadline_and_the_summary_is_still_written(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            status, summary, elapsed = self._run(root, [sys.executable, "-c", "import time; time.sleep(30)"])
            self.assertEqual(status, 0)
            self.assertLess(elapsed, 3)
            self.assertEqual(summary["evidence_withheld"], "export_deadline")
            self.assertIsNone(summary["evidence_sha256"])
            self.assertFalse((root / "logs" / shim.ANALYSIS_NAME).exists())

    def test_a_sigterm_that_stops_an_unsettled_turn_is_a_cancellation_bounded_from_the_sigterm(self) -> None:
        # Harbor sends SIGKILL two seconds after SIGTERM, so the summary must land
        # inside that window even when the child is still running at SIGTERM.
        sigterm_delay = 0.3
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            self._sigterm_after(sigterm_delay)
            status, summary, elapsed = self._run(root, [sys.executable, "-c", "import time; time.sleep(30)"], "import time; time.sleep(30)", export_budget=30)
            self.assertEqual(status, 143)
            self.assertLess(elapsed - sigterm_delay, 2)
            self.assertEqual(summary["adapter_settlement"], "harbor-cancellation")
            self.assertEqual(summary["evidence_withheld"], "export_deadline")

    def test_a_sigterm_during_the_teardown_of_an_answered_prompt_is_a_normal_end(self) -> None:
        # The child still tears down when Harbor's SIGTERM follows the answer.
        # Flywheel answers only a settled turn: a model reply with background
        # work still running streams an update and no answer.
        cases = (
            ("answered", {"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "end_turn"}}, "normal"),
            ("failed", {"jsonrpc": "2.0", "id": 2, "error": {"code": -32603, "message": "The turn ended before it completed"}}, "normal"),
            ("unanswered", {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "root", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done."}}}}, "harbor-cancellation"),
            ("cancelled", {"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "cancelled"}}, "harbor-cancellation"),
        )
        for name, line, settlement in cases:
            with self.subTest(name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                _store(root / "project", "ordinary event")
                self._sigterm_after(0.3)
                child = f"import sys, time; sys.stdout.write({json.dumps(json.dumps(line) + chr(10))}); sys.stdout.flush(); time.sleep(30)"
                status, summary, _ = self._run(root, child_code=child, export_budget=30)
                self.assertEqual(status, 143)
                self.assertEqual(summary["adapter_settlement"], settlement)
                self.assertEqual(summary["captured_after_cancellation"], settlement != "normal")
                self.assertTrue(summary["evidence_exported"])

if __name__ == "__main__":
    unittest.main()
