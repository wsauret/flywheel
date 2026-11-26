"""Grade every position of the original hidden tests on its own, inside the original pytest run.

The adapter installs this file as conftest.py beside the restored original test module, so the
original verifier loads it as a pytest plugin. The original tests run unchanged and keep their
verdicts, CTRF, and reward. The plugin memoizes the module's run_solution, so each distinct
position is computed once: the original tests stop each game at its first failed position, and
after the session the plugin grades every distinct input position (by FEN) as one check,
reusing the positions that the original tests already computed. A position passes when the
generated positions, with the original en passant tolerance applied, have no duplicates and
equal the python-chess set of legal successor positions. The size-limit check is the original
test_not_long.

The adapter writes positions-config.json beside this file: {"solution": <re.json>, "result": <path>}.
"""
import io
import json
from pathlib import Path

import chess
import chess.pgn

CONFIG = json.loads(Path(__file__).with_name("positions-config.json").read_text())
_tests = None


def _memoized(run_solution):
    outcomes = {}

    def run(fen):
        if fen not in outcomes:
            try:
                outcomes[fen] = (True, run_solution(fen))
            except Exception as error:
                outcomes[fen] = (False, error)
        succeeded, value = outcomes[fen]
        if not succeeded:
            raise value
        return value

    return run


def pytest_collection_modifyitems(items):
    global _tests
    for item in items:
        module = getattr(item, "module", None)
        if module is not None and module is not _tests and hasattr(module, "run_solution"):
            _tests = module
            # verify_legal_moves reads run_solution as a module global, so the original tests use the memo.
            module.run_solution = _memoized(module.run_solution)


def load_error():
    try:
        json.loads(Path(CONFIG["solution"]).read_text())
    except (OSError, UnicodeDecodeError, ValueError) as error:
        return type(error).__name__
    return None


def game_positions(pgn_str):
    """The FENs that the original do_test_game checks: the start, then the position before each odd move."""
    pgn_str = pgn_str.strip().replace('\r\n', '\n')
    if pgn_str.startswith('\ufeff'):
        pgn_str = pgn_str[1:]
    game = chess.pgn.read_game(io.StringIO(pgn_str))
    board = game.board()
    fens = [board.fen()]
    for count, move in enumerate(game.mainline_moves(), start=1):
        if count % 2 == 1:
            fens.append(board.fen())
        board.push(move)
    return fens


def legal_successors(fen):
    board = chess.Board(fen)
    successors = set()
    for move in board.legal_moves:
        if move.promotion and move.promotion != chess.QUEEN:
            continue
        board_copy = board.copy()
        board_copy.push(move)
        successors.add(" ".join(board_copy.fen().split(" ")[:-2]))
    return successors


def grade_position(fen):
    expected = legal_successors(fen)
    try:
        generated = _tests.run_solution(fen)
    except Exception as error:
        return {"passed": False, "error": type(error).__name__, "oracle": len(expected)}
    normalized = [x if x in expected else x.rpartition(" ")[0] + " -" for x in generated]
    distinct = set(normalized)
    return {
        "passed": len(distinct) == len(normalized) and distinct == expected,
        "generated": len(generated), "distinct": len(distinct), "oracle": len(expected),
        "missing": len(expected - distinct), "unexpected": len(distinct - expected),
    }


def collect_games():
    games = []
    original = _tests.do_test_game
    _tests.do_test_game = lambda pgn_str, game_name="Unnamed Game": games.append((game_name, pgn_str))
    try:
        for name, value in vars(_tests).copy().items():
            if name.startswith("test_") and callable(value) and "do_test_game" in value.__code__.co_names:
                value()
    finally:
        _tests.do_test_game = original
    return games


def pytest_sessionfinish(session, exitstatus):
    if _tests is None:
        raise RuntimeError("the original test module was not collected")
    games = collect_games()
    error = load_error()
    checks = {}
    positions = []
    if error is None:
        for game_name, pgn_str in games:
            for fen in game_positions(pgn_str):
                check = f"position:{fen}"
                if check in checks:
                    continue
                outcome = grade_position(fen)
                checks[check] = outcome["passed"]
                positions.append({"id": check, "game": game_name, **outcome})
        try:
            _tests.test_not_long()
            checks["size-limit"] = True
        except Exception:
            checks["size-limit"] = False
    Path(CONFIG["result"]).write_text(json.dumps({
        "loadError": error, "games": [name for name, _ in games], "checks": checks, "positions": positions,
    }, indent=2) + "\n")
