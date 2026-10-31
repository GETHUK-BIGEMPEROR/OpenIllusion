import importlib.util
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def _load_backend(monkeypatch):
    fake = types.ModuleType("setuptools")
    fake.build_meta = types.SimpleNamespace()
    monkeypatch.setitem(sys.modules, "setuptools", fake)
    spec = importlib.util.spec_from_file_location("build_backend_test", ROOT / "build_backend.py")
    build_backend = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build_backend)
    return build_backend, fake.build_meta


def test_wheel_backend_builds_the_locked_ui(monkeypatch):
    build_backend, _ = _load_backend(monkeypatch)
    seen = []
    monkeypatch.setattr(build_backend.shutil, "which", lambda name: "npm-test" if name == "npm" else None)
    monkeypatch.setattr(build_backend.subprocess, "run", lambda cmd, **kw: seen.append((cmd, kw)))
    build_backend._build_ui()
    assert [x[0] for x in seen] == [
        ["npm-test", "ci", "--no-audit", "--no-fund"],
        ["npm-test", "run", "build"],
    ]
    assert all(x[1]["cwd"] == ROOT / "ui" and x[1]["check"] for x in seen)


def test_wheel_backend_clears_stale_setuptools_assets(monkeypatch):
    build_backend, setuptools = _load_backend(monkeypatch)
    seen = []
    monkeypatch.setattr(build_backend, "_build_ui", lambda: seen.append("ui"))
    monkeypatch.setattr(build_backend.shutil, "rmtree", lambda path, **kw: seen.append((path, kw)))
    setuptools.build_wheel = lambda *a: "made.whl"
    assert build_backend.build_wheel("dist") == "made.whl"
    assert seen == ["ui", (ROOT / "build" / "lib", {"ignore_errors": True})]


def test_distribution_declares_every_runtime_resource_package():
    project = (ROOT / "pyproject.toml").read_text("utf-8")
    assert 'include = ["server*", "templates*", "schema*"]' in project
    assert 'templates = ["local/*.json"' in project and 'schema = ["*.json"]' in project
    assert (ROOT / "templates" / "__init__.py").is_file()
    assert (ROOT / "schema" / "__init__.py").is_file()
