import json
from pathlib import Path

from openillusion import engines

FIX = Path(__file__).parent / "fixtures"


def schema_props(name):
    doc = json.loads((FIX / name).read_text("utf-8"))
    path = next(iter(doc["paths"].values()))
    return path["post"]["requestBody"]["content"]["application/json"]["schema"]


def spec(engine, **kw):
    s = {
        "engine": engine,
        "inputs": [
            {"slot": "video:1", "role": "motion", "asset": "v.mp4", "duration": 8},
            {"slot": "image:1", "role": "character", "asset": "a.png"},
            {"slot": "image:2", "role": "outfit", "asset": "b.png"},
        ],
        "prompt": "Image 1 is the character. Video 1 is the motion. Night rooftop, rain.",
        "params": {"duration": 8, "resolution": "768P", "ratio": "9:16", "seed": 418877},
    }
    s.update(kw)
    return s


def test_h3_body_uses_reference_roles_and_matches_schema():
    out = engines.compose(spec("minimax/minimax-h3"))
    body = out["template"]
    assert out["warnings"] == []
    assert body["content"][0] == {"type": "text", "text": spec("x")["prompt"]}
    roles = [c.get("role") for c in body["content"][1:]]
    assert roles == ["reference_image", "reference_image", "reference_video"]
    assert body["content"][3]["video_url"]["url"] == "{{video:1}}"
    s = schema_props("minimax-h3.json")
    assert set(s["required"]) <= set(body)
    assert set(body) <= set(s["properties"])
    assert s["properties"]["duration"]["minimum"] <= body["duration"] <= s["properties"]["duration"]["maximum"]


def test_h3_adaptive_ratio_and_random_seed_are_omitted():
    body = engines.compose(spec("minimax/minimax-h3", params={"duration": 6, "resolution": "2K", "ratio": "adaptive", "seed": -1}))["template"]
    assert "ratio" not in body and "seed" not in body


def test_prompt_is_never_rewritten():
    p = "  keep   my   spacing  "
    body = engines.compose(spec("minimax/minimax-h3", prompt=p))["template"]
    assert body["content"][0]["text"] == p


def test_video_window_is_enforced():
    s = spec("minimax/minimax-h3")
    s["inputs"][0]["trimmed_duration"] = 20
    w = engines.compose(s)["warnings"]
    assert any(x["field"] == "video" and "2–15" in x["text"] for x in w)


def test_genjutsu_needs_urls():
    s = spec("higgsfield/higgsfield-genjutsu-motion-transfer-v1.0", params={"resolution": "720p"})
    out = engines.compose(s)
    assert any("public URLs" in w["text"] for w in out["warnings"])
    assert out["template"]["video_url"] == "{{video:1|url}}"
    props = schema_props("higgsfield-genjutsu-motion-transfer-v1.0.json")["properties"]
    assert set(out["template"]) <= set(props)


def test_flux3_boxes_ride_at_end_of_prompt():
    s = {
        "engine": "bfl/flux-3-image",
        "inputs": [{"slot": "image:1", "role": "base", "asset": "a.png"}],
        "prompt": "Make it rain.",
        "boxes": [
            {"rect": [0.1, 0.2, 0.3, 0.4], "label": "replace jacket with a yellow raincoat"},
            {"rect": [0.5, 0.5, 0.1, 0.1], "label": ""},
        ],
        "params": {"resolution": "2k"},
    }
    body = engines.compose(s)["template"]
    first, json_line = body["prompt"].split("\n")
    assert first == "Make it rain."
    rows = json.loads(json_line)
    assert rows == [{
        "id": "box_1", "from": "image_1", "src_bbox": [200, 100, 600, 400], "tgt_bbox": [200, 100, 600, 400],
        "desc": "replace jacket with a yellow raincoat",
    }]
    assert body["images"] == ["{{image:1|b64}}"]
    props = schema_props("flux-3-image.json")["properties"]
    assert set(body) <= set(props)


def test_materialize_replaces_only_whole_tokens():
    t = {"a": "{{image:1}}", "b": ["{{video:1|url}}", "text {{image:1}}"], "c": {"d": "{{image:2|b64}}"}}
    out = engines.materialize(t, lambda k, n, f: f"{k}{n}-{f}")
    assert out == {"a": "image1-uri", "b": ["video1-url", "text {{image:1}}"], "c": {"d": "image2-b64"}}
    assert t["a"] == "{{image:1}}"  # template untouched


def test_role_sentences():
    s = engines.role_sentences([{"slot": "image:1", "role": "character"}, {"slot": "video:1", "role": "motion"}])
    assert s == "Image 1 is the character. Video 1 is the motion."


def test_result_parsing():
    h3 = {"task": {"status": "succeeded", "content": {"url": "https://x/generated.mp4"}, "seed": 5}}
    assert engines.find_assets(h3) == ["https://x/generated.mp4"]
    assert engines.result_seed(h3) == 5
    flux = {"id": "1", "status": "Ready", "result": {"sample": "https://cdn/s?sig=1", "seed": 2784347701}}
    assert engines.find_assets(flux) == ["https://cdn/s?sig=1"]
    assert engines.result_seed(flux) == 2784347701
    hf = {"status": "completed", "status_url": "https://api/s", "video": {"url": "https://v/out.mp4"}}
    assert engines.find_assets(hf) == ["https://v/out.mp4"]
    assert engines.classify_failure({"status": "nsfw"})["error_type"] == "content_policy_violation"
    assert engines.classify_failure({"task": {"status": "failed", "error": {"message": "boom"}}})["message"] == "boom"
    assert engines.classify_failure(h3) is None
