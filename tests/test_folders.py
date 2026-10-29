"""The folder picker's listing (server/folders.py): folders only, hidden ones out, safe names for new ones."""

import pytest

from server import folders


def test_lists_folders_only_sorted_and_without_hidden(tmp_path):
    for n in ("beta", "Alpha", ".cache"):
        (tmp_path / n).mkdir()
    (tmp_path / "file.txt").write_text("x")
    d = folders.listing(str(tmp_path))
    assert [x["name"] for x in d["dirs"]] == ["Alpha", "beta"]
    assert d["path"] == str(tmp_path.resolve()) and d["parent"] == str(tmp_path.resolve().parent)
    assert d["writable"] and not d["denied"] and not d["missing"]
    assert d["roots"] and any(p["label"] == "Home" for p in d["places"])


def test_a_missing_path_opens_its_nearest_parent(tmp_path):
    d = folders.listing(str(tmp_path / "gone" / "deeper"))
    assert d["path"] == str(tmp_path.resolve()) and d["missing"]


def test_relative_paths_are_refused():
    with pytest.raises(folders.FolderError):
        folders.listing("some/relative")


def test_make_a_folder_and_refuse_bad_names(tmp_path):
    d = folders.make(str(tmp_path), "Renders")
    assert (tmp_path / "Renders").is_dir() and d["made"] == str(tmp_path.resolve() / "Renders")
    for bad in ("", "..", "a/b", "a\b", "con", "x:y", "trail.", "Renders"):
        with pytest.raises(folders.FolderError):
            folders.make(str(tmp_path), bad)
