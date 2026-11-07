import hashlib
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
    from .harbor_agent.flywheel_harbor_agent import shim, trial_runtime
except ImportError:
    from harbor_agent.flywheel_harbor_agent import shim, trial_runtime

SNAPSHOT_KEY = "sk-test-" + "k" * 40
SNAPSHOT = {
    "profile": "benchmark",
    "credentials": {"openai_api": {"type": "api_key", "key": SNAPSHOT_KEY, "lineageId": "11111111-1111-4111-8111-111111111111"}},
    "modelAccess": [],
}
PROMPT = {"jsonrpc": "2.0", "id": 2, "method": "session/prompt", "params": {"sessionId": "root", "prompt": []}}


def _store(project: Path, value: str) -> None:
    flywheel = project / ".flywheel"
    flywheel.mkdir(mode=0o700, parents=True)
    connection = sqlite3.connect(flywheel / "flywheel.sqlite")
    connection.execute("create table event (payload text)")
    connection.execute("insert into event values (?)", (value,))
    connection.commit()
    connection.close()


def _drain(descriptor: int) -> bytes:
    """Every byte that the non-blocking pipe `descriptor` holds now."""
    chunks = []
    while True:
        try:
            chunk = os.read(descriptor, 65536)
        except BlockingIOError:
            return b"".join(chunks)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


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
        stage_file, profile, credential_values = shim.take_snapshot(environ)
        try:
            self.assertEqual(environ, {"KEEP": "1"})
            self.assertEqual(profile, "benchmark")
            self.assertEqual(credential_values, {SNAPSHOT_KEY: "api_key.key"})
            self.assertEqual(stage_file.name, "auth.json")
            self.assertTrue(stage_file.parent.name.startswith("flywheel-auth-bundle-"))
            self.assertEqual(stat.S_IMODE(stage_file.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(stage_file.stat().st_mode), 0o600)
            self.assertEqual(json.loads(stage_file.read_text()), SNAPSHOT)
        finally:
            stage_file.unlink()
            stage_file.parent.rmdir()

    def test_names_every_token_of_a_subscription_and_a_token_login_but_no_account_name(self) -> None:
        snapshot = {
            "profile": "benchmark",
            "credentials": {"openai": [{"id": "instance-0001", "identity": "person@example.com", "lineageId": "22222222-2222-4222-8222-222222222222", "credential": {"type": "oauth", "access": "access-" + "a" * 30, "refresh": "refresh-" + "r" * 30, "expires": 1, "accountId": "account-identity-0001"}}]},
            "externalLogins": {"claude": {"access": "token-" + "t" * 30}},
        }
        self.assertEqual(shim.snapshot_credential_values(snapshot), {
            "access-" + "a" * 30: "oauth.access",
            "refresh-" + "r" * 30: "oauth.refresh",
            "token-" + "t" * 30: "external_login.access",
        })

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

    def test_the_child_runs_an_unattended_acp_chat_on_the_staged_snapshot(self) -> None:
        command = shim._child_command(Path("/bun/bin"), Path("/runtime"), "benchmark", Path("/stage/auth.json"))
        self.assertEqual(command[:3], ["/bun/bin/bun", "--conditions=browser", "/runtime/src/cli/index.ts"])
        # No person reads a trial, so the shim asks Flywheel for an unattended run (PI-AGENT-121).
        self.assertEqual(command[3:], ["--headless", "--acp", "--unattended", "--allow-persistent-processes", "--auth-profile", "benchmark", "--auth-snapshot", "/stage/auth.json"])


class ExportEvidenceTest(unittest.TestCase):
    def test_records_the_analysis_of_the_store_that_it_captures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            logs, private = root / "logs", root / "private"
            logs.mkdir()
            private.mkdir(mode=0o700)
            publication, withheld = shim.export_evidence(root / "project", private, logs, _bun(root), _analyzer(root))
            self.assertIsNone(withheld)
            self.assertEqual(sorted(path.name for path in logs.iterdir()), [shim.ANALYSIS_NAME])
            self.assertEqual(json.loads((logs / shim.ANALYSIS_NAME).read_text())["store"], {"sha256": publication.sha256, "size": publication.size})
            self.assertEqual(hashlib.sha256((private / ".flywheel" / "flywheel.sqlite").read_bytes()).hexdigest(), publication.sha256)

    def test_records_nothing_when_the_analysis_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            logs, private = root / "logs", root / "private"
            logs.mkdir()
            private.mkdir(mode=0o700)
            failing = root / "failing.py"
            failing.write_text("import sys; sys.exit(3)\n")
            self.assertEqual(shim.export_evidence(root / "project", private, logs, _bun(root), failing), (None, "analysis_failed:exit_3"))
            self.assertEqual(list(logs.iterdir()), [])


class RunShutdownTest(unittest.TestCase):
    """Drives `shim.run` with a stub child, as Flywheel behaves when Harbor closes stdin or sends SIGTERM."""

    def _run(self, root: Path, export_command: list[str] | None = None, child_code: str = "pass") -> tuple[int, dict, float, bytes]:
        """Run the shim on a Harbor input that holds one prompt and stays open, and return its status, summary, time, and Harbor output."""
        project, logs = root / "project", root / "logs"
        logs.mkdir(exist_ok=True)
        tools = root / "tools"
        tools.mkdir()
        _bun(tools)
        analyzer = _analyzer(tools)
        harbor_in_read, harbor_in_write = os.pipe()
        harbor_out_read, harbor_out_write = os.pipe()
        os.write(harbor_in_write, json.dumps(PROMPT).encode() + b"\n")
        harbor_in = os.fdopen(harbor_in_read, "rb")
        self.addCleanup(os.close, harbor_out_read)
        self.addCleanup(os.close, harbor_out_write)
        self.addCleanup(os.close, harbor_in_write)
        stubs = [
            patch.object(shim, "read_build_record", lambda _root: {"build_id": "b" * 12, "flywheel_source": {"commit": "c" * 40}, "runtime_archive": {"path": "archive", "sha256": "d" * 64}, "flywheel_config": {"path": "config"}, "store_analyzer": {"path": str(analyzer)}}),
            patch.object(shim, "_install_bun", lambda _work: tools),
            patch.object(shim, "_install_runtime", lambda work, _archive, _bin: work),
            patch.object(shim, "_install_home", lambda work, _config, _profile: work / "home"),
            patch.object(shim, "_child_command", lambda *_: [sys.executable, "-c", child_code]),
        ]
        self.addCleanup(signal.signal, signal.SIGTERM, signal.getsignal(signal.SIGTERM))
        if export_command is not None:
            stubs.append(patch.object(shim, "_command", lambda _step: export_command))
        for stub in stubs:
            stub.start()
            self.addCleanup(stub.stop)
        os.set_blocking(harbor_out_read, False)
        self.harbor_output_at_summary = None
        real_summary = shim._write_run_summary

        def summary_then_note_output(*arguments, **keywords):
            written = real_summary(*arguments, **keywords)
            self.harbor_output_at_summary = _drain(harbor_out_read)
            return written

        summary_stub = patch.object(shim, "_write_run_summary", summary_then_note_output)
        summary_stub.start()
        self.addCleanup(summary_stub.stop)
        started = time.monotonic()
        status = shim.run({shim.SNAPSHOT_ENV: json.dumps(SNAPSHOT)}, project, logs, root, harbor_in, harbor_out_write)
        elapsed = time.monotonic() - started
        output = self.harbor_output_at_summary + _drain(harbor_out_read)
        return status, json.loads((logs / "flywheel-run-summary.json").read_text()), elapsed, output

    def _sigterm_after(self, delay: float) -> None:
        sender = threading.Timer(delay, os.kill, (os.getpid(), signal.SIGTERM))
        sender.start()
        self.addCleanup(sender.cancel)

    def test_records_the_store_analysis_and_publishes_the_analyzed_store_and_every_log(self) -> None:
        # The child writes a log file into the account home, as Flywheel's
        # account-scoped processes do, beside the project log.
        child = "import os; os.makedirs(os.path.expanduser('~/.flywheel/log')); open(os.path.expanduser('~/.flywheel/log/2-account.jsonl'), 'w').write('{}\\n')"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            (root / "project" / ".flywheel" / "log").mkdir()
            (root / "project" / ".flywheel" / "log" / "1-project.jsonl").write_text("{}\n")
            status, summary, _, _ = self._run(root, child_code=child)
            analysis = json.loads((root / "logs" / shim.ANALYSIS_NAME).read_text())
            evidence = root / "logs" / trial_runtime.EVIDENCE_DIR_NAME / ".flywheel"
            self.assertEqual(status, 0)
            self.assertNotIn("evidence_withheld", summary)
            self.assertEqual(summary["adapter_settlement"], "normal")
            self.assertEqual(summary["evidence_sha256"], analysis["store"]["sha256"])
            self.assertEqual(hashlib.sha256((evidence / "flywheel.sqlite").read_bytes()).hexdigest(), analysis["store"]["sha256"])
            self.assertEqual(sorted(path.name for path in (evidence / "log").iterdir()), ["1-project.jsonl", "2-account.jsonl"])
            self.assertEqual(summary["debug_evidence"], {"published": [".flywheel/flywheel.sqlite", ".flywheel/log/1-project.jsonl", ".flywheel/log/2-account.jsonl"], "withheld": {}})
            self.assertEqual(stat.S_IMODE((evidence / "flywheel.sqlite").stat().st_mode), 0o600)
            self.assertFalse((root / "logs" / "state").exists())

    def test_withholds_evidence_that_holds_a_snapshot_credential_and_names_only_its_kind(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", f"a tool printed {SNAPSHOT_KEY}")
            log = root / "project" / ".flywheel" / "log"
            log.mkdir()
            (log / "1-project.jsonl").write_text("{}\n")
            # A credential in a log's name, over clean and over credential bytes.
            (log / f"2-{SNAPSHOT_KEY}.jsonl").write_text("{}\n")
            (log / f"3-{SNAPSHOT_KEY}.jsonl").write_text(SNAPSHOT_KEY)
            status, summary, _, _ = self._run(root)
            evidence = root / "logs" / trial_runtime.EVIDENCE_DIR_NAME / ".flywheel"
            self.assertEqual(status, 0)
            self.assertTrue(summary["evidence_exported"])
            self.assertTrue((root / "logs" / shim.ANALYSIS_NAME).exists())
            self.assertFalse((evidence / "flywheel.sqlite").exists())
            self.assertEqual(summary["debug_evidence"], {"published": [".flywheel/log/1-project.jsonl"], "withheld": {
                ".flywheel/flywheel.sqlite": "credential:api_key.key",
                ".flywheel/log/<withheld name 2>": "credential:api_key.key",
                ".flywheel/log/<withheld name 3>": "credential:api_key.key",
            }})
            for path in (root / "logs").rglob("*"):
                self.assertNotIn(SNAPSHOT_KEY, path.name, path)
                if path.is_file():
                    self.assertNotIn(SNAPSHOT_KEY.encode(), path.read_bytes(), path)

    def test_a_failed_publication_keeps_the_analysis_and_the_trial(self) -> None:
        # A path the agent planted where the evidence goes is never written through.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            outside = root / "outside"
            outside.mkdir()
            (root / "logs").mkdir()
            (root / "logs" / trial_runtime.EVIDENCE_DIR_NAME).symlink_to(outside, target_is_directory=True)
            status, summary, _, _ = self._run(root)
            self.assertEqual(status, 0)
            self.assertTrue(summary["evidence_exported"])
            self.assertEqual(summary["debug_evidence"], {"failed": "publish_failed:exit_1"})
            self.assertEqual(list(outside.iterdir()), [])

    def test_a_private_directory_that_cannot_be_made_still_writes_the_summary(self) -> None:
        real_mkdtemp = shim.tempfile.mkdtemp

        def refuse_evidence(*arguments, prefix=None, **keywords):
            if prefix == "flywheel-evidence-":
                raise OSError("no space left on device")
            return real_mkdtemp(*arguments, prefix=prefix, **keywords)

        with tempfile.TemporaryDirectory() as directory, patch.object(shim.tempfile, "mkdtemp", refuse_evidence):
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            status, summary, _, _ = self._run(root)
            self.assertEqual(status, 0)
            self.assertEqual(summary["evidence_withheld"], "export_failed:OSError")
            self.assertEqual(summary["debug_evidence"], {"failed": "publish_failed:OSError"})

    def test_a_fifo_among_the_logs_is_withheld_without_blocking_the_others(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            log = root / "project" / ".flywheel" / "log"
            log.mkdir()
            (log / "1-project.jsonl").write_text("{}\n")
            os.mkfifo(log / "2-fifo.jsonl", 0o600)
            status, summary, _, _ = self._run(root)
            self.assertEqual(status, 0)
            self.assertEqual(summary["debug_evidence"], {"published": [".flywheel/flywheel.sqlite", ".flywheel/log/1-project.jsonl"], "withheld": {".flywheel/log/2-fifo.jsonl": "unsafe_source"}})

    def test_a_settled_answer_ends_flywheel_and_reaches_harbor_only_after_the_run_summary(self) -> None:
        # Harbor never closes its input here, so the child ends only because the
        # shim closes the child's stdin on the settled answer. The child then
        # writes to its store, as Flywheel's teardown does, before it exits.
        answer = json.dumps({"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "end_turn"}}) + "\n"
        child = (
            "import select, sqlite3, sys\n"
            "sys.stdin.readline()\n"
            f"sys.stdout.write({answer!r}); sys.stdout.flush()\n"
            "if not select.select([sys.stdin], [], [], 5)[0] or sys.stdin.read(): sys.exit(3)\n"
            "connection = sqlite3.connect('.flywheel/flywheel.sqlite'); connection.execute(\"insert into event values ('teardown')\"); connection.commit()\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            status, summary, _, output = self._run(root, child_code=child)
            self.assertEqual(status, 0)
            self.assertEqual(summary["adapter_settlement"], "normal")
            self.assertTrue(summary["evidence_exported"])
            self.assertEqual(self.harbor_output_at_summary, b"")
            self.assertEqual(output, answer.encode())
            # The export read the store after the teardown write.
            connection = sqlite3.connect(root / "project" / ".flywheel" / "flywheel.sqlite")
            try:
                self.assertEqual(connection.execute("select count(*) from event").fetchone(), (2,))
            finally:
                connection.close()

    def test_a_sigterm_that_stops_an_unsettled_turn_is_a_cancellation_bounded_from_the_sigterm(self) -> None:
        # Harbor sends SIGKILL two seconds after SIGTERM, so the summary must land
        # inside that window even when the child is still running at SIGTERM.
        sigterm_delay = 0.3
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            self._sigterm_after(sigterm_delay)
            status, summary, elapsed, _ = self._run(root, [sys.executable, "-c", "import time; time.sleep(30)"], "import time; time.sleep(30)")
            self.assertEqual(status, 143)
            self.assertLess(elapsed - sigterm_delay, 2)
            self.assertEqual(summary["adapter_settlement"], "harbor-cancellation")
            self.assertEqual(summary["evidence_withheld"], "export_deadline")
            self.assertEqual(summary["debug_evidence"], {"failed": "publish_deadline"})
            self.assertFalse((root / "logs" / trial_runtime.EVIDENCE_DIR_NAME).exists())

    def test_a_sigterm_after_a_settled_answer_is_a_normal_end(self) -> None:
        # Flywheel answers only a settled turn: a model reply with background
        # work still running streams an update and no answer. Only the answer
        # to a prompt counts; an error to another request settles nothing.
        cases = (
            ("answered", {"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "end_turn"}}, "normal"),
            ("failed", {"jsonrpc": "2.0", "id": 2, "error": {"code": -32603, "message": "The turn ended before it completed"}}, "normal"),
            ("unanswered", {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "root", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done."}}}}, "harbor-cancellation"),
            ("cancelled", {"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "cancelled"}}, "harbor-cancellation"),
            ("another request failed", {"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "Method not found"}}, "harbor-cancellation"),
        )
        for name, message, settlement in cases:
            with self.subTest(name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                _store(root / "project", "ordinary event")
                self._sigterm_after(0.3)
                line = json.dumps(message) + "\n"
                child = f"import sys, time; sys.stdin.readline(); sys.stdout.write({line!r}); sys.stdout.flush(); time.sleep(30)"
                status, summary, _, output = self._run(root, child_code=child)
                self.assertEqual(status, 143)
                self.assertEqual(summary["adapter_settlement"], settlement)
                self.assertEqual(summary["captured_after_cancellation"], settlement != "normal")
                self.assertTrue(summary["evidence_exported"])
                self.assertEqual(output, line.encode())


class SettledEvidenceExportTest(unittest.TestCase):
    """The capture of the trial store that every trial's analysis reads."""

    def _workspace(self, root: Path) -> tuple[Path, Path, Path]:
        workspace = root.resolve() / "workspace"
        database = workspace / ".flywheel" / "flywheel.sqlite"
        evidence = root / "evidence"
        database.parent.mkdir(parents=True)
        evidence.mkdir()
        connection = sqlite3.connect(database)
        connection.execute("CREATE TABLE facts (value TEXT NOT NULL)")
        connection.execute("INSERT INTO facts VALUES ('trusted')")
        connection.commit()
        connection.close()
        return workspace, database, evidence

    def _wal(self, database: Path) -> sqlite3.Connection:
        connection = sqlite3.connect(database)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("INSERT INTO facts VALUES ('wal-only')")
        connection.commit()
        return connection

    def test_publishes_a_verified_private_copy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, _, evidence = self._workspace(Path(directory))
            publication = trial_runtime._export_settled_sqlite(workspace, evidence)
            exported = evidence / ".flywheel" / "flywheel.sqlite"
            self.assertEqual(publication.sha256, hashlib.sha256(exported.read_bytes()).hexdigest())
            self.assertEqual(stat.S_IMODE(exported.stat().st_mode), 0o600)
            connection = sqlite3.connect(exported)
            try:
                self.assertEqual(connection.execute("SELECT value FROM facts").fetchone(), ("trusted",))
            finally:
                connection.close()

    def test_publishes_committed_rows_that_exist_only_in_the_wal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, database, evidence = self._workspace(Path(directory))
            connection = self._wal(database)
            try:
                self.assertTrue(database.with_name(f"{database.name}-wal").exists())
                trial_runtime._export_settled_sqlite(workspace, evidence)
            finally:
                connection.close()
            exported = sqlite3.connect(evidence / ".flywheel" / "flywheel.sqlite")
            try:
                self.assertEqual(exported.execute("SELECT value FROM facts ORDER BY rowid").fetchall(), [("trusted",), ("wal-only",)])
            finally:
                exported.close()

    def test_refuses_an_unsafe_wal_without_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, database, evidence = self._workspace(Path(directory))
            connection = self._wal(database)
            database.with_name(f"{database.name}-wal").chmod(0o666)
            try:
                with self.assertRaisesRegex(RuntimeError, "sidecar"):
                    trial_runtime._export_settled_sqlite(workspace, evidence)
            finally:
                connection.close()
            self.assertFalse((evidence / ".flywheel" / "flywheel.sqlite").exists())

    def test_refuses_a_wal_replaced_during_the_backup_without_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace, database, evidence = self._workspace(root)
            connection = self._wal(database)
            wal = database.with_name(f"{database.name}-wal")
            replacement = root / "replacement-wal"
            replacement.write_bytes(wal.read_bytes())
            real_backup = trial_runtime._backup_sqlite

            def replace_wal_then_backup(source_path, destination_path):
                os.replace(replacement, wal)
                real_backup(source_path, destination_path)

            try:
                with patch.object(trial_runtime, "_backup_sqlite", side_effect=replace_wal_then_backup), self.assertRaisesRegex(RuntimeError, "sidecar"):
                    trial_runtime._export_settled_sqlite(workspace, evidence)
            finally:
                connection.close()
            self.assertFalse((evidence / ".flywheel" / "flywheel.sqlite").exists())

    def test_refuses_a_symlinked_or_missing_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace, database, evidence = self._workspace(root)
            target = root / "elsewhere.sqlite"
            database.rename(target)
            database.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "source"):
                trial_runtime._export_settled_sqlite(workspace, evidence)
            database.unlink()
            with self.assertRaisesRegex(RuntimeError, "missing"):
                trial_runtime._export_settled_sqlite(workspace, evidence)

    def test_refuses_a_symlinked_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace, _, evidence = self._workspace(root)
            outside = root / "outside"
            outside.mkdir()
            (evidence / ".flywheel").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "destination"):
                trial_runtime._export_settled_sqlite(workspace, evidence)
            self.assertEqual(list(outside.iterdir()), [])

    def test_a_failed_backup_publishes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, _, evidence = self._workspace(Path(directory))
            with patch.object(trial_runtime, "_backup_sqlite", side_effect=RuntimeError("backup failed")), self.assertRaisesRegex(RuntimeError, "backup failed"):
                trial_runtime._export_settled_sqlite(workspace, evidence)
            self.assertFalse((evidence / ".flywheel" / "flywheel.sqlite").exists())


if __name__ == "__main__":
    unittest.main()
