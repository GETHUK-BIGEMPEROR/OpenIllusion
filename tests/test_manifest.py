import json

import pytest

from server import generation as sc


def base(**kw):
    d = {
        "format": "openillusion.generation",
        "version": 1,
        "id": sc.new_id(),
        "title": "Hallway take → rainy rooftop",
        "mode": "motion",
        "engine": {"kind": "router", "model": "minimax/minimax-h3", "provider": "comfy"},
        "inputs": [
            {"slot": "video:1", "role": "motion", "file": "driving/driving.mp4", "license": "own-footage", "contains_person": True, "consent": True},
            {"slot": "image:1", "role": "character", "file": "refs/ref-01.webp", "license": "generated"},
        ],
        "prompt": "Image 1 is the character. Video 1 is the motion.",
        "params": {"duration": 8, "resolution": "768P", "ratio": "9:16", "seed": 418877},
        "outcome": "worked",
    }
    d.update(kw)
    return d


def test_plan_example_parses():
    m, unknown = sc.parse(base())
    assert m.engine.model == "minimax/minimax-h3"
    assert m.inputs[0].contains_person and m.inputs[0].consent
    assert unknown == []


def test_unknown_fields_are_kept_but_ignored():
    m, unknown = sc.parse(base(sparkles=True, version=2))
    assert unknown == ["sparkles"]
    assert sc.dump(m)["sparkles"] is True


@pytest.mark.parametrize("bad", [{"format": "other"}, {"version": 0}, {"mode": "dance"}, {"outcome": "great"}])
def test_bad_manifests_are_refused(bad):
    with pytest.raises(sc.ManifestError):
        sc.parse(base(**bad))


def test_missing_engine_is_refused():
    d = base()
    del d["engine"]
    with pytest.raises(sc.ManifestError) as e:
        sc.parse(d)
    assert "engine" in str(e.value)


def test_ids_sort_by_time():
    import time

    a = sc.new_id()
    time.sleep(0.002)
    b = sc.new_id()
    assert len(a) == 26 and a < b


def test_schema_file_is_current():
    from pathlib import Path

    f = Path(__file__).resolve().parent.parent / "schema" / "generation.v1.json"
    assert json.loads(f.read_text("utf-8")) == json.loads(json.dumps(sc.json_schema())), "run: python -m server.gen_schema"


def test_licenses_md_lists_every_input():
    m, _ = sc.parse(base())
    md = sc.licenses_md(m)
    assert "own-footage" in md and "yes, consent given" in md and "image:1" in md
