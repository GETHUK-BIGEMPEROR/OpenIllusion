"""Install, update and start OpenIllusion in one step: what start.bat and start.sh run.

Each start does only what changed since the last one: makes ``.venv`` if it's missing,
reinstalls the Python side when its metadata, constraints or version changed, reinstalls the UI's packages
when ``ui/package-lock.json`` changed, rebuilds the UI when anything under ``ui/``
changed, then runs the server and opens the browser. What was done is remembered in
``.venv/openillusion-stamps.json``, so a second start goes straight to the server.

    start.bat [--update] [--no-open] [server options, e.g. --port 7871]

``--update`` runs ``git pull --ff-only`` first. Anything else goes to ``python -m server``.
"""
# Kept to syntax an old Python can parse, so one that's too old gets the message below.
from __future__ import annotations

import sys

if sys.version_info < (3, 10):
    sys.exit("OpenIllusion needs Python 3.10 or newer; this is %d.%d. "
             "Get it from https://www.python.org/downloads/ and run start again." % sys.version_info[:2])

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV = ROOT / ".venv"
VENV_PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
STAMPS = VENV / "openillusion-stamps.json"
UI = ROOT / "ui"
BUILT = ROOT / "server" / "static" / "index.html"
UI_INPUTS = ["src", "public", "index.html", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts"]
PYTHON_INPUTS = ["pyproject.toml", "constraints.txt", "build_backend.py", "server/__init__.py"]
NODE_HINT = ("Node.js 18 or newer builds the app's page: https://nodejs.org"
             + (" (or: winget install OpenJS.NodeJS.LTS)" if os.name == "nt" else "")
             + ". Install it, open a new terminal, and run start again.")


def say(msg: str) -> None:
    print(f"[OpenIllusion] {msg}", flush=True)


def fail(msg: str) -> None:
    say(msg)
    raise SystemExit(1)


def fingerprint(base: Path, names: list[str]) -> str:
    """A hash of every file under ``names`` (files or folders, relative to ``base``)."""
    h = hashlib.sha256()
    for name in names:
        p = base / name
        files = sorted(f for f in p.rglob("*") if f.is_file()) if p.is_dir() else [p] if p.is_file() else []
        for f in files:
            h.update(f.relative_to(base).as_posix().encode() + b"\0" + f.read_bytes() + b"\0")
    return h.hexdigest()


def load_stamps() -> dict:
    try:
        return json.loads(STAMPS.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def save_stamp(key: str, value: str) -> None:
    stamps = load_stamps()
    stamps[key] = value
    STAMPS.write_text(json.dumps(stamps, indent=2), "utf-8")


def run(cmd: list[str], what: str, cwd: Path = ROOT) -> None:
    if subprocess.run(cmd, cwd=cwd).returncode != 0:
        fail(f"{what} failed (see above). Fix that and run start again.")


def update() -> None:
    git = shutil.which("git")
    if not git or not (ROOT / ".git").exists():
        fail("--update needs git and a git clone of OpenIllusion.")
    say("Getting the latest version...")
    run([git, "pull", "--ff-only"], "git pull")


def python_side() -> None:
    if not VENV_PY.exists():
        say("Making the Python environment in .venv...")
        if subprocess.run([sys.executable, "-m", "venv", str(VENV)]).returncode != 0:
            fail("Couldn't make .venv." + (" On Debian or Ubuntu: sudo apt install python3-venv" if os.name != "nt" else ""))
    want = fingerprint(ROOT, PYTHON_INPUTS)
    if load_stamps().get("python") == want:
        return
    say("Installing the Python packages (the first time takes a minute or two)...")
    run([str(VENV_PY), "-m", "pip", "install", "-q", "--disable-pip-version-check",
         "-c", "constraints.txt", "-e", "."], "pip install")
    save_stamp("python", want)


def node_version(node: str) -> int:
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True).stdout
        return int(out.strip().lstrip("v").split(".")[0])
    except (OSError, ValueError):
        return 0


def ui_side() -> None:
    want = fingerprint(UI, UI_INPUTS)
    if BUILT.exists() and load_stamps().get("ui") == want:
        return
    npm, node = shutil.which("npm"), shutil.which("node")
    if not npm or not node or node_version(node) < 18:
        if BUILT.exists():
            say("The app's page is older than the code, and it can't be rebuilt here. " + NODE_HINT)
            return
        fail(NODE_HINT)
    deps = fingerprint(UI, ["package-lock.json"])
    if not (UI / "node_modules").is_dir() or load_stamps().get("ui-packages") != deps:
        say("Installing the page's packages...")
        run([npm, "ci", "--no-audit", "--no-fund"], "npm ci", cwd=UI)
        save_stamp("ui-packages", deps)
    say("Building the app's page...")
    run([npm, "run", "build"], "Building the page", cwd=UI)
    save_stamp("ui", want)


def main(argv: list[str]) -> int:
    args = list(argv)
    if "--update" in args:
        args.remove("--update")
        update()
    python_side()
    ui_side()
    if "--no-open" in args:
        args.remove("--no-open")
    elif "--open" not in args:
        args.append("--open")
    say("Starting. Leave this window open while you use the app; close it (or Ctrl+C) to stop.")
    try:
        return subprocess.run([str(VENV_PY), "-m", "server", *args], cwd=ROOT).returncode
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
