"""scripts/launch.py: start.bat redoes a step only when that step's inputs changed."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("launch", Path(__file__).parent.parent / "scripts" / "launch.py")
launch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(launch)


def test_fingerprint_follows_contents_and_names(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.ts").write_text("one")
    (tmp_path / "package-lock.json").write_text("{}")
    names = ["src", "package-lock.json", "missing.json"]
    first = launch.fingerprint(tmp_path, names)
    assert launch.fingerprint(tmp_path, names) == first

    (tmp_path / "src" / "a.ts").write_text("two")
    second = launch.fingerprint(tmp_path, names)
    assert second != first

    (tmp_path / "src" / "a.ts").rename(tmp_path / "src" / "b.ts")
    assert launch.fingerprint(tmp_path, names) != second


def test_fingerprint_ignores_what_it_is_not_given(tmp_path):
    (tmp_path / "package-lock.json").write_text("{}")
    before = launch.fingerprint(tmp_path, ["package-lock.json"])
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "x.js").write_text("x")
    assert launch.fingerprint(tmp_path, ["package-lock.json"]) == before


def test_every_build_input_that_changes_the_output_is_stamped():
    assert {"package.json", "package-lock.json", "src", "public"} <= set(launch.UI_INPUTS)
    assert {"pyproject.toml", "constraints.txt", "build_backend.py", "server/__init__.py"} <= set(launch.PYTHON_INPUTS)
