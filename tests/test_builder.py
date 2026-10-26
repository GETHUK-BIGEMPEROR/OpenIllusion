import io
import json

import pytest

from server import builder, engines

# A slice of /object_info: enough node types to build a small edit graph.
INFO = {
    "LoadImage": {"input": {"required": {"image": [["a.png", "b.png"], {"image_upload": True}]}}, "output_node": False},
    "CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": [["m.safetensors"], {}]}}},
    "CLIPTextEncode": {"input": {"required": {"text": ["STRING", {"multiline": True}], "clip": ["CLIP", {}]}}},
    "KSampler": {
        "input": {"required": {
            "model": ["MODEL", {}],
            "seed": ["INT", {"default": 0, "min": 0, "max": 2**32, "control_after_generate": True}],
            "steps": ["INT", {"default": 20, "min": 1, "max": 100}],
            "cfg": ["FLOAT", {"default": 7.0, "min": 0.0, "max": 30.0, "step": 0.1}],
            "sampler_name": [["euler", "dpmpp_2m"], {}],
            "positive": ["CONDITIONING", {}],
            "negative": ["CONDITIONING", {}],
            "latent_image": ["LATENT", {}],
            "denoise": ["FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0}],
        }},
        "input_order": {"required": ["model", "seed", "steps", "cfg", "sampler_name", "positive", "negative", "latent_image", "denoise"]},
    },
    "VAEEncode": {"input": {"required": {"pixels": ["IMAGE", {}], "vae": ["VAE", {}]}}},
    "VAEDecode": {"input": {"required": {"samples": ["LATENT", {}], "vae": ["VAE", {}]}}},
    "ImageInvert": {"input": {"required": {"image": ["IMAGE", {}]}}},
    "SaveImage": {"input": {"required": {"images": ["IMAGE", {}], "filename_prefix": ["STRING", {"default": "ComfyUI"}]}}, "output_node": True},
}


def ui_graph():
    """Root: loader → reroute → subgraph(encode, sample) → bypassed invert → save; prompt promoted on the instance."""
    sub = {
        "id": "sg-1", "name": "Sample",
        "inputs": [{"name": "pixels", "type": "IMAGE", "linkIds": [101]}, {"name": "text", "type": "STRING", "linkIds": [102]}],
        "outputs": [{"name": "IMAGE", "type": "IMAGE", "linkIds": [999]}],  # stale on purpose; the -20 link wins
        "nodes": [
            {"id": 1, "type": "CheckpointLoaderSimple", "mode": 0, "widgets_values": ["m.safetensors"], "inputs": []},
            {"id": 2, "type": "CLIPTextEncode", "mode": 0, "widgets_values": ["inner default"],
             "inputs": [{"name": "clip", "link": 103, "type": "CLIP"}, {"name": "text", "link": 102, "type": "STRING", "widget": {"name": "text"}}]},
            {"id": 3, "type": "CLIPTextEncode", "mode": 0, "widgets_values": ["blurry"], "inputs": [{"name": "clip", "link": 104, "type": "CLIP"}]},
            {"id": 4, "type": "VAEEncode", "mode": 0, "inputs": [{"name": "pixels", "link": 101, "type": "IMAGE"}, {"name": "vae", "link": 105, "type": "VAE"}]},
            {"id": 5, "type": "KSampler", "mode": 0, "widgets_values": [42, "randomize", 8, 4.5, "euler", 0.6],
             "inputs": [{"name": "model", "link": 106}, {"name": "positive", "link": 107}, {"name": "negative", "link": 108}, {"name": "latent_image", "link": 109}]},
            {"id": 6, "type": "VAEDecode", "mode": 0, "inputs": [{"name": "samples", "link": 110}, {"name": "vae", "link": 111}]},
        ],
        "links": [
            {"id": 101, "origin_id": -10, "origin_slot": 0, "target_id": 4, "target_slot": 0, "type": "IMAGE"},
            {"id": 102, "origin_id": -10, "origin_slot": 1, "target_id": 2, "target_slot": 1, "type": "STRING"},
            {"id": 103, "origin_id": 1, "origin_slot": 1, "target_id": 2, "target_slot": 0, "type": "CLIP"},
            {"id": 104, "origin_id": 1, "origin_slot": 1, "target_id": 3, "target_slot": 0, "type": "CLIP"},
            {"id": 105, "origin_id": 1, "origin_slot": 2, "target_id": 4, "target_slot": 1, "type": "VAE"},
            {"id": 106, "origin_id": 1, "origin_slot": 0, "target_id": 5, "target_slot": 0, "type": "MODEL"},
            {"id": 107, "origin_id": 2, "origin_slot": 0, "target_id": 5, "target_slot": 1, "type": "CONDITIONING"},
            {"id": 108, "origin_id": 3, "origin_slot": 0, "target_id": 5, "target_slot": 2, "type": "CONDITIONING"},
            {"id": 109, "origin_id": 4, "origin_slot": 0, "target_id": 5, "target_slot": 3, "type": "LATENT"},
            {"id": 110, "origin_id": 5, "origin_slot": 0, "target_id": 6, "target_slot": 0, "type": "LATENT"},
            {"id": 111, "origin_id": 1, "origin_slot": 2, "target_id": 6, "target_slot": 1, "type": "VAE"},
            {"id": 112, "origin_id": 6, "origin_slot": 0, "target_id": -20, "target_slot": 0, "type": "IMAGE"},
        ],
    }
    return {
        "nodes": [
            {"id": 10, "type": "LoadImage", "mode": 0, "title": "Photo", "widgets_values": ["a.png", "image"], "outputs": [{"type": "IMAGE"}]},
            {"id": 11, "type": "Reroute", "mode": 0, "inputs": [{"name": "", "link": 1, "type": "*"}], "outputs": [{"type": "IMAGE"}]},
            {"id": 12, "type": "sg-1", "mode": 0, "widgets_values": ["a red hat"],
             "inputs": [{"name": "pixels", "link": 2, "type": "IMAGE"}, {"name": "text", "link": None, "type": "STRING", "widget": {"name": "text"}}]},
            {"id": 13, "type": "ImageInvert", "mode": 4, "inputs": [{"name": "image", "link": 3, "type": "IMAGE"}], "outputs": [{"type": "IMAGE"}]},
            {"id": 14, "type": "SaveImage", "mode": 0, "widgets_values": ["out"], "inputs": [{"name": "images", "link": 4, "type": "IMAGE"}]},
            {"id": 15, "type": "MarkdownNote", "mode": 0, "widgets_values": ["hello"]},
            {"id": 16, "type": "SaveImage", "mode": 2, "widgets_values": ["muted"], "inputs": [{"name": "images", "link": 5, "type": "IMAGE"}]},
        ],
        "links": [[1, 10, 0, 11, 0, "IMAGE"], [2, 11, 0, 12, 0, "IMAGE"], [3, 12, 0, 13, 0, "IMAGE"], [4, 13, 0, 14, 0, "IMAGE"], [5, 10, 0, 16, 0, "IMAGE"]],
        "definitions": {"subgraphs": [sub]},
    }


def test_ui_graph_flattens_to_api():
    api, notes = builder.ui_to_api(ui_graph(), INFO)
    assert not notes
    assert set(api) == {"10", "14", "12:1", "12:2", "12:3", "12:4", "12:5", "12:6"}  # note, reroute, bypassed and muted nodes gone
    assert api["10"]["inputs"] == {"image": "a.png"}  # the upload button's value is skipped
    assert api["12:4"]["inputs"]["pixels"] == ["10", 0]  # through the reroute and into the subgraph
    assert api["12:2"]["inputs"]["text"] == "a red hat"  # promoted widget value from the instance
    assert api["12:5"]["inputs"] | {} == {
        "seed": 42, "steps": 8, "cfg": 4.5, "sampler_name": "euler", "denoise": 0.6,  # "randomize" is skipped
        "model": ["12:1", 0], "positive": ["12:2", 0], "negative": ["12:3", 0], "latent_image": ["12:4", 0],
    }
    assert api["14"]["inputs"]["images"] == ["12:6", 0]  # bypassed invert passes its input through
    assert api["10"]["_meta"]["title"] == "Photo"


def test_older_saves_get_new_widgets_from_defaults():
    ui = {"nodes": [{"id": 1, "type": "KSampler", "mode": 0, "widgets_values": [1, "fixed", 9]}], "links": []}
    api, _ = builder.ui_to_api(ui, INFO)
    assert api["1"]["inputs"] == {"seed": 1, "steps": 9, "cfg": 7.0, "sampler_name": "euler", "denoise": 1.0}


def test_analyze_suggests_slots_prompt_and_controls():
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    a = builder.analyze(api, INFO)
    assert a["outputs"] == ["14"]
    assert [(m["slot"], m["node"], m["input"], m["value"]) for m in a["media"]] == [("image:1", "10", "image", "a.png")]
    assert a["prompt"] == {"node": "12:2", "input": "text"}
    assert {t["node"]: t["polarity"] for t in a["texts"]} == {"12:2": "positive", "12:3": "negative"}
    suggested = {p["input"]: p["type"] for p in a["params"] if p["suggested"]}
    assert suggested == {"seed": "seed", "steps": "int", "cfg": "number", "denoise": "number"}
    assert not any(p["input"] == "ckpt_name" for p in a["params"])  # model files are requirements
    assert a["mode"] == "edit"


def test_no_save_node_is_refused():
    ui = {"nodes": [{"id": 1, "type": "LoadImage", "mode": 0, "widgets_values": ["a.png", "image"]}], "links": []}
    api, _ = builder.ui_to_api(ui, INFO)
    with pytest.raises(builder.BuildError, match="no Save node"):
        builder.analyze(api, INFO)


def test_api_json_and_png_are_read():
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    got, ui = builder.read_workflow("w.json", json.dumps(api).encode())
    assert got == api and ui is None
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo

    meta = PngInfo()
    meta.add_text("prompt", json.dumps(api))
    meta.add_text("workflow", json.dumps(ui_graph()))
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, "PNG", pnginfo=meta)
    got, ui = builder.read_workflow("out.png", buf.getvalue())
    assert got == api and ui["nodes"]
    with pytest.raises(builder.BuildError):
        builder.read_workflow("x.json", b'{"hello": 1}')


def _local_spec(**over):
    spec = {
        "label": "Red hat", "blurb": "Puts a hat on", "tags": ["Hat"],
        "media": [{"node": "10", "input": "image", "kind": "image", "label": "Photo", "required": True}],
        "prompt": {"node": "12:2", "input": "text", "label": "What hat", "default": "Add a red hat to the person."},
        "params": [{"node": "12:5", "input": "steps", "type": "int", "label": "Steps", "min": 1, "max": 30},
                   {"node": "12:5", "input": "seed", "type": "seed"},
                   {"node": "12:5", "input": "sampler_name", "type": "select", "options": ["euler", "dpmpp_2m"]}],
    }
    spec.update(over)
    return spec


def test_local_template_round_trip():
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    data = builder.assemble_local(_local_spec(), {"workflow": api}, INFO)
    assert data["workflow"]["10"]["inputs"]["image"] == "{{image:1}}"
    by = {f["key"]: f for f in data["inputs"]}
    assert data["version"] == 2 and list(by) == ["image:1", "prompt", "steps", "seed", "sampler_name"]
    assert by["image:1"]["bind"] == [["10", "image"]] and by["prompt"]["bind"] == [["12:2", "text"]]
    assert by["steps"]["bind"] == [["12:5", "steps", "int"]]
    assert by["sampler_name"]["bind"] == [["12:5", "sampler_name", "str"]]
    assert [by[k]["type"] for k in ("steps", "seed", "sampler_name")] == ["int", "seed", "segmented"]
    assert by["steps"]["default"] == 8 and by["seed"]["default"] == -1 and by["seed"]["advanced"]
    # The saved workflow carries the default prompt itself; nothing is wrapped around what people type.
    assert data["workflow"]["12:2"]["inputs"]["text"] == "Add a red hat to the person."
    data["id"] = "red-hat"
    e = engines.load_template(data)
    assert e.id == "local/red-hat" and e.built and e.min_images == 1 and e.tags == ["hat"]
    assert e.default_prompt == "Add a red hat to the person."
    wf = e.build({"inputs": [{"slot": "image:1"}], "prompt": "Add a blue cap.", "params": {"steps": 12, "seed": 5, "sampler_name": "dpmpp_2m"}})
    assert wf["12:2"]["inputs"]["text"] == "Add a blue cap."
    assert wf["12:5"]["inputs"]["steps"] == 12 and wf["12:5"]["inputs"]["sampler_name"] == "dpmpp_2m"


def test_local_spec_needs_a_name_and_real_nodes():
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    with pytest.raises(builder.BuildError, match="name"):
        builder.assemble_local(_local_spec(label=" "), {"workflow": api}, INFO)
    with pytest.raises(builder.BuildError, match="isn't in the workflow"):
        builder.assemble_local(_local_spec(params=[{"node": "99", "input": "x", "type": "int"}]), {"workflow": api}, INFO)


SCHEMA = {
    "type": "object", "required": ["prompt", "image_urls"],
    "properties": {
        "prompt": {"type": "string"},
        "image_urls": {"type": "array", "items": {"type": "string", "format": "uri"}, "maxItems": 4},
        "aspect_ratio": {"type": "string", "enum": ["1:1", "16:9", "9:16"], "default": "1:1"},
        "seed": {"type": "integer"},
        "steps": {"type": "integer", "minimum": 1, "maximum": 50, "default": 28},
        "safety": {"type": "boolean", "default": True},
    },
}


def test_schema_is_split_like_a_workflow():
    a = builder.analyze_schema(SCHEMA)
    assert a["prompt"] == {"field": "prompt", "required": True}
    assert [(m["field"], m["kind"], m["many"], m["max"]) for m in a["media"]] == [("image_urls", "image", True, 4)]
    assert {p["field"]: p["type"] for p in a["params"]} == {"aspect_ratio": "select", "seed": "seed", "steps": "int", "safety": "bool"}


def test_cloud_template_round_trip():
    data = builder.assemble_cloud({
        "model": "acme/edit-1", "label": "Studio shot",
        "media": [{"field": "image_urls", "kind": "image", "many": True, "label": "Product"},
                  {"field": "image_urls", "kind": "image", "many": True, "label": "Backdrop", "required": False}],
        "prompt": {"field": "prompt", "default": "Product photo, on marble"},
        "params": [{"field": "aspect_ratio", "type": "select", "options": ["1:1", "16:9"], "default": "1:1"}, {"field": "seed", "type": "seed"}],
        "fixed": {"safety": False},
    })
    assert data["body"] == {"safety": False, "image_urls": ["{{image:1}}", "{{image:2}}"], "prompt": "Product photo, on marble"}
    assert [(f["key"], f.get("required"), f["bind"]) for f in data["inputs"][:2]] == [("image:1", True, [["image_urls", 0]]), ("image:2", False, [["image_urls", 1]])]
    data["id"] = "studio-shot"
    e = engines.load_template(data)
    assert e.id == "cloud/studio-shot" and e.kind == "cloud" and e.model == "acme/edit-1"
    assert e.min_images == 1 and e.max_images == 2
    body = e.build({"inputs": [{"slot": "image:1"}], "prompt": "Product photo, on oak", "params": {"aspect_ratio": "16:9", "seed": 7}})
    assert body == {"safety": False, "image_urls": ["{{image:1}}"], "prompt": "Product photo, on oak", "aspect_ratio": "16:9", "seed": 7}
    body = e.build({"inputs": [], "prompt": "x", "params": {"seed": -1}})
    assert "image_urls" not in body and 0 <= body["seed"] < 2**31


def test_save_writes_user_template_with_samples(tmp_path, monkeypatch):
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    data = builder.assemble_local(_local_spec(), {"workflow": api}, INFO)
    sample = tmp_path / "s.png"
    from PIL import Image

    Image.new("RGB", (64, 48), (9, 9, 9)).save(sample)
    monkeypatch.setattr(engines, "ENGINES", dict(engines.ENGINES))
    tid = builder.save(data, {"image:1": sample}, sample, taken={"local/red-hat"})
    assert tid == "local/red-hat-2"
    engines.reload_templates()
    e = engines.ENGINES[tid]
    assert e.origin == "user" and e.built and e.default_inputs["image:1"].is_file() and e.cover.is_file()
    d = engines.describe(e)
    assert d["defaults"]["inputs"][0]["slot"] == "image:1" and d["fields"][0]["sample"]["slot"] == "image:1"
    assert "default" not in d["fields"][0] and "bind" in d["fields"][0]
    engines.delete_template(tid)
    assert tid not in engines.ENGINES and not e.default_inputs["image:1"].exists()


def test_fixed_settings_change_the_workflow_only():
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    data = builder.assemble_local(_local_spec(params=[], fixed=[{"node": "12:5", "input": "steps", "value": 20}]), {"workflow": api}, INFO)
    assert data["workflow"]["12:5"]["inputs"]["steps"] == 20 and [f["key"] for f in data["inputs"]] == ["image:1", "prompt"]
    with pytest.raises(builder.BuildError, match="expects number"):
        builder.assemble_local(_local_spec(fixed=[{"node": "12:5", "input": "steps", "value": "lots"}]), {"workflow": api}, INFO)
