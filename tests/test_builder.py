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


def test_each_seed_keeps_its_control_after_generate():
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    assert api["12:5"]["_meta"]["control_after_generate"] == {"seed": "randomize"}
    ui = {"nodes": [{"id": 1, "type": "KSampler", "mode": 0, "widgets_values": [1, "fixed", 9]},
                    {"id": 2, "type": "PrimitiveNode", "mode": 0, "widgets_values": [5, "randomize"], "outputs": [{"type": "INT"}]},
                    {"id": 3, "type": "KSampler", "mode": 0, "widgets_values": [0, "fixed", 9],
                     "inputs": [{"name": "seed", "link": 1, "type": "INT", "widget": {"name": "seed"}}]}],
          "links": [[1, 2, 0, 3, 0, "INT"]]}
    api, _ = builder.ui_to_api(ui, INFO)
    assert api["1"]["_meta"]["control_after_generate"] == {"seed": "fixed"}
    assert api["3"]["inputs"]["seed"] == 5 and api["3"]["_meta"]["control_after_generate"] == {"seed": "randomize"}  # the primitive's own


def test_a_run_rerolls_randomize_and_keeps_fixed():
    wf = {"1": {"class_type": "KSampler", "inputs": {"seed": 1}, "_meta": {"control_after_generate": {"seed": "randomize"}}},
          "2": {"class_type": "KSampler", "inputs": {"seed": 1}, "_meta": {"control_after_generate": {"seed": "fixed"}}},
          "3": {"class_type": "KSampler", "inputs": {"seed": 1}}}
    seeds = {engines.reroll(json.loads(json.dumps(wf)))["1"]["inputs"]["seed"] for _ in range(5)}
    assert len(seeds) > 1
    out = engines.reroll(json.loads(json.dumps(wf)))
    assert out["2"]["inputs"]["seed"] == 1 and out["3"]["inputs"]["seed"] == 1


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


def test_a_math_expression_is_not_a_prompt():
    info = {**INFO, "ComfyMathExpression": {"input": {"required": {"expression": ["STRING", {"default": "a + b", "multiline": True}]}}, "output": ["FLOAT", "INT", "BOOLEAN"]}}
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    api["99"] = {"class_type": "ComfyMathExpression", "inputs": {"expression": "max(5, round(a * 24))"}}
    a = builder.analyze(api, info)
    assert "99" not in {t["node"] for t in a["texts"]} and a["prompt"] == {"node": "12:2", "input": "text"}


def test_no_save_node_is_refused():
    ui = {"nodes": [{"id": 1, "type": "LoadImage", "mode": 0, "widgets_values": ["a.png", "image"]}], "links": []}
    api, _ = builder.ui_to_api(ui, INFO)
    with pytest.raises(builder.BuildError, match="no Save node"):
        builder.analyze(api, INFO)


OUT_INFO = {
    **INFO,
    "EmptyAudio": {"input": {"required": {}}},
    "SaveAudio": {"input": {"required": {"audio": ["AUDIO", {}], "filename_prefix": ["STRING", {}]}}, "output_node": True},
    "EmptyMesh": {"input": {"required": {}}},
    "SaveGLB": {"input": {"required": {"mesh": ["MESH,FILE_3D_GLB,FILE_3D", {}], "filename_prefix": ["STRING", {}]}}, "output_node": True},
    "PreviewAny": {"input": {"required": {"source": ["*", {}]}}, "output_node": True},
}


def test_output_kind_reads_the_wired_type():
    api = {
        "1": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
        "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "x"}},
        "3": {"class_type": "EmptyAudio", "inputs": {}},
        "4": {"class_type": "SaveAudio", "inputs": {"audio": ["3", 0], "filename_prefix": "x"}},
        "5": {"class_type": "EmptyMesh", "inputs": {}},
        "6": {"class_type": "SaveGLB", "inputs": {"mesh": ["5", 0], "filename_prefix": "x"}},
        "7": {"class_type": "PreviewAny", "inputs": {"source": ["1", 0]}},
    }
    assert [builder.output_kind(api, n, OUT_INFO) for n in ("2", "4", "6", "7")] == ["image", "audio", "3d", "text"]
    assert [r["node"] for r in builder.result_nodes(api, OUT_INFO)] == ["2"]
    a = builder.analyze(api, OUT_INFO)
    # The result comes from the Save Image node; the graph stays whole, so the other outputs still run.
    assert a["outputs"] == ["2"] and {"4", "6", "7"} <= set(a["workflow"])
    assert len(a["notes"]) == 3 and "also saves audio" in a["notes"][0]


def test_workflow_without_an_image_or_video_is_refused():
    api = {
        "3": {"class_type": "EmptyAudio", "inputs": {}},
        "4": {"class_type": "SaveAudio", "inputs": {"audio": ["3", 0], "filename_prefix": "x"}},
        "5": {"class_type": "EmptyMesh", "inputs": {}},
        "6": {"class_type": "SaveGLB", "inputs": {"mesh": ["5", 0], "filename_prefix": "x"}},
    }
    with pytest.raises(builder.BuildError, match="saves a 3D model and audio, not an image or video"):
        builder.analyze(api, OUT_INFO)


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


def test_save_writes_user_template_with_samples(tmp_path, monkeypatch):
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    data = builder.assemble_local(_local_spec(), {"workflow": api}, INFO)
    sample = tmp_path / "s.png"
    from PIL import Image

    Image.new("RGB", (64, 48), (9, 9, 9)).save(sample)
    monkeypatch.setattr(engines, "ENGINES", dict(engines.ENGINES))
    tid = builder.save(data, {"image:1": sample}, taken={"local/red-hat"})
    assert tid == "local/red-hat-2"
    engines.reload_templates()
    e = engines.ENGINES[tid]
    assert e.origin == "user" and e.built and e.default_inputs["image:1"].is_file() and e.cover is None
    d = engines.describe(e)
    assert "draft" not in d and d["cover"] is None  # on Explore at once; no cover until a result is made one
    assert d["defaults"]["inputs"][0]["slot"] == "image:1" and d["fields"][0]["sample"]["slot"] == "image:1"
    assert "default" not in d["fields"][0] and "bind" in d["fields"][0]
    engines.set_cover(tid, sample)
    assert engines.describe(e)["cover"]
    builder.save(builder.assemble_local(_local_spec(), {"workflow": api}, INFO), {"image:1": sample}, replace=tid)
    engines.reload_templates()
    e = engines.ENGINES[tid]
    assert engines.describe(e)["cover"]  # rebuilding keeps the cover
    engines.delete_template(tid)
    assert tid not in engines.ENGINES and not e.default_inputs["image:1"].exists()


def test_fixed_settings_change_the_workflow_only():
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    data = builder.assemble_local(_local_spec(params=[], fixed=[{"node": "12:5", "input": "steps", "value": 20}]), {"workflow": api}, INFO)
    assert data["workflow"]["12:5"]["inputs"]["steps"] == 20 and [f["key"] for f in data["inputs"]] == ["image:1", "prompt"]
    with pytest.raises(builder.BuildError, match="expects number"):
        builder.assemble_local(_local_spec(fixed=[{"node": "12:5", "input": "steps", "value": "lots"}]), {"workflow": api}, INFO)


REFMOD_INFO = {
    **INFO,
    "MiniMaxH3RefModsLoader": {"input": {"required": {
        "mod_1": [["(none)", "mara.safetensors"], {}], "strength_1": ["FLOAT", {"default": 1.0}],
        "mod_2": [["(none)", "mara.safetensors"], {}], "strength_2": ["FLOAT", {"default": 1.0}]}}},
    "H3Apply": {"input": {"required": {"image": ["IMAGE", {}], "mods": ["H3_REFMODS", {}]}}},
}


def refmod_graph(mod_1="(none)"):
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
        "2": {"class_type": "MiniMaxH3RefModsLoader", "inputs": {"mod_1": mod_1, "strength_1": 1.0, "mod_2": "(none)", "strength_2": 1.0}},
        "3": {"class_type": "H3Apply", "inputs": {"image": ["1", 0], "mods": ["2", 0]}},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "out"}},
    }


def test_a_refmod_loader_becomes_refmod_inputs():
    a = builder.analyze(refmod_graph(), REFMOD_INFO)
    assert [(r["input"], r["slot"], r["suggested"]) for r in a["refmods"]] == [("mod_1", "refmod:1", True), ("mod_2", "refmod:2", False)]
    assert not any(p["input"].startswith("mod_") for p in a["params"]) and a["check"]["bad_values"] == []
    # A slot the workflow already fills is the one suggested.
    a = builder.analyze(refmod_graph(mod_1="(none)") | {"2": {**refmod_graph()["2"], "inputs": {**refmod_graph()["2"]["inputs"], "mod_2": "mara.safetensors"}}}, REFMOD_INFO)
    assert [r["suggested"] for r in a["refmods"]] == [False, True]


def test_kept_refmod_slots_are_picked_at_run_time():
    spec = {"label": "Swap", "media": [{"node": "1", "input": "image", "kind": "image"}],
            "refmods": [{"node": "2", "input": "mod_1", "photo": {"node": "1", "input": "image"}}, {"node": "2", "input": "mod_2"}],
            "prompt": None}
    data = builder.assemble_local(spec, {"workflow": refmod_graph(mod_1="mara.safetensors")}, REFMOD_INFO)
    by = {f["key"]: f for f in data["inputs"]}
    assert list(by) == ["image:1", "refmod:1", "refmod:2"]
    assert by["refmod:1"] == {"key": "refmod:1", "type": "refmod", "required": True, "bind": [["2", "mod_1"]], "photo": "image:1"}
    assert data["workflow"]["2"]["inputs"]["mod_1"] == "(none)"
    data["id"] = "swap"
    e = engines.load_template(data)
    wf = e.build({"inputs": [{"slot": "image:1"}, {"slot": "refmod:1"}, {"slot": "refmod:2"}], "prompt": "", "params": {}})
    assert wf["2"]["inputs"]["mod_1"] == "{{refmod:1}}" and wf["2"]["inputs"]["mod_2"] == "{{refmod:2}}"
    # One left empty loads nothing there; the loader and what follows it still run.
    wf = e.build({"inputs": [{"slot": "image:1"}, {"slot": "refmod:1"}], "prompt": "", "params": {}})
    assert wf["2"]["inputs"]["mod_2"] == "(none)" and set(wf) == {"1", "2", "3", "4"}
    # Its face goes into a photo input, nothing else.
    with pytest.raises(builder.BuildError, match="photo inputs"):
        builder.assemble_local({**spec, "refmods": [{"node": "2", "input": "mod_1", "photo": {"node": "9", "input": "image"}}]},
                               {"workflow": refmod_graph()}, REFMOD_INFO)


def test_a_refmod_template_opens_in_the_builder_as_it_is():
    p = builder.preset(engines.get("local/minimax-h3-character-refmod"))
    img = next(m for m in p["media"] if m["slot"] == "image:1")
    assert p["refmods"] == [{"node": "201", "input": "mod_1", "slot": "refmod:1", "photo": {"node": img["node"], "input": img["input"]}}]
    assert not any(x["input"].startswith("mod_") for x in p["params"])


def test_a_template_rebuilt_in_the_builder_keeps_its_settings():
    e = engines.get("local/minimax-h3-create")
    p = builder.preset(e)
    dur = next(x for x in p["params"] if x["key"] == "duration")
    assert dur["type"] == "segmented" and dur["options"] == [3, 5, 8, 10, 15] and dur["unit"] == "s"
    assert p["size"] == {"node": "140:131", "label": "Output size", "aspect": "16:9", "default": "0.4 MP"}
    spec = {"label": "Clip", "mode": "motion", "media": [], "outputs": list(e.outputs), "size": p["size"],
            "prompt": {**p["prompt"], "label": "Prompt", "hint": ""},
            "params": [{k: dur[k] for k in ("node", "input", "key", "type", "label", "options", "unit", "default")}]}
    data = builder.assemble_local(spec, {"workflow": e.workflow}, {"SaveVideo": {"input": {"required": {}}, "output_node": True}})
    by = {f["key"]: f for f in data["inputs"]}
    assert by["duration"]["options"] == [3, 5, 8, 10, 15] and by["duration"]["unit"] == "s" and by["duration"]["default"] == 5
    assert by["duration"]["bind"] == [["140:133", "value", "float"]]  # whole seconds into a float input
    assert by["size"]["aspect"] == "16:9" and by["size"]["default"] == "0.4 MP"
