"""PEP 517 backend that makes a wheel contain the web app it serves.

Editable installs keep the normal launcher/Docker flow: those build the UI separately.
A distributable wheel, however, must never silently install a server whose `/` is a 503,
so a wheel build runs the locked frontend build before setuptools collects package data.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from setuptools import build_meta as _setuptools


ROOT = Path(__file__).resolve().parent
UI = ROOT / "ui"


def _build_ui() -> None:
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("Building an OpenIllusion wheel needs Node.js 18+ and npm")
    subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=UI, check=True)
    subprocess.run([npm, "run", "build"], cwd=UI, check=True)


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    _build_ui()
    # setuptools reuses build/lib and otherwise leaves removed hashed Vite assets in
    # later wheels. Only its generated package tree is cleared; audit/output folders
    # under build/ are unrelated and stay intact.
    shutil.rmtree(ROOT / "build" / "lib", ignore_errors=True)
    return _setuptools.build_wheel(wheel_directory, config_settings, metadata_directory)


def build_sdist(sdist_directory, config_settings=None):
    return _setuptools.build_sdist(sdist_directory, config_settings)


def get_requires_for_build_wheel(config_settings=None):
    return _setuptools.get_requires_for_build_wheel(config_settings)


def get_requires_for_build_sdist(config_settings=None):
    return _setuptools.get_requires_for_build_sdist(config_settings)


def prepare_metadata_for_build_wheel(metadata_directory, config_settings=None):
    return _setuptools.prepare_metadata_for_build_wheel(metadata_directory, config_settings)


if hasattr(_setuptools, "build_editable"):
    build_editable = _setuptools.build_editable
    get_requires_for_build_editable = _setuptools.get_requires_for_build_editable
    prepare_metadata_for_build_editable = _setuptools.prepare_metadata_for_build_editable
