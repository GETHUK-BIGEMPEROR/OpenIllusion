"""The template contract: a workflow is a black box. A template writes only what it declares
(files into loaders, text into text boxes, values into settings, an output size where the author
put it), keeps the result of the output node its author picked, and never touches the rest of the graph."""

import pytest

from server import builder, engines


def INT(d, lo=16, hi=16384, step=16):
    return ["INT", {"default": d, "min": lo, "max": hi, "step": step}]


INFO = {
    "LoadImage": {"input": {"required": {"image": [["a.png"], {"image_upload": True}]}}},
    "VHS_LoadVideo": {"input": {"required": {"video": [["clip.mp4"], {"video_upload": True}], "force_rate": ["FLOAT", {"default": 0}],
                                              "frame_load_cap": INT(0, 0, 9999, 1)}}},
    "LoadImageFromPath": {"input": {"required": {"path": ["STRING", {"default": ""}]}}},
    "CLIPTextEncode": {"input": {"required": {"text": ["STRING", {"multiline": True}], "clip": ["CLIP", {}]}}},
    "WanImageToVideo": {"input": {"required": {"positive": ["CONDITIONING", {}], "negative": ["CONDITIONING", {}], "start_image": ["IMAGE", {}],
                                                "width": INT(832), "height": INT(480), "length": INT(81, 1, 1000, 4)}}},
    "EmptyLatentImage": {"input": {"required": {"width": INT(1024), "height": INT(1024), "batch_size": INT(1, 1, 64, 1)}}},
    "KSampler": {"input": {"required": {"seed": INT(0, 0, 2**32, 1), "steps": INT(20, 1, 100, 1), "positive": ["CONDITIONING", {}],
                                         "negative": ["CONDITIONING", {}], "latent_image": ["LATENT", {}]}}},
    "VAEDecode": {"input": {"required": {"samples": ["LATENT", {}]}}},
    "CreateVideo": {"input": {"required": {"images": ["IMAGE", {}], "fps": ["FLOAT", {"default": 16}]}}},
    "SaveVideo": {"input": {"required": {"video": ["VIDEO", {}]}}, "output_node": True},
    "SaveImage": {"input": {"required": {"images": ["IMAGE", {}]}}, "output_node": True},
    "PreviewImage": {"input": {"required": {"images": ["IMAGE", {}]}}, "output_node": True},
}


def wan_i2v():
    """Wan-shaped image to video: one photo, a positive and a negative prompt, a fixed 832x480 canvas, a preview on the side."""
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "a woman turns and smiles", "clip": ["9", 0]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, static", "clip": ["9", 0]}},
        "4": {"class_type": "WanImageToVideo", "inputs": {"positive": ["2", 0], "negative": ["3", 0], "start_image": ["1", 0],
                                                          "width": 832, "height": 480, "length": 81}},
        "5": {"class_type": "KSampler", "inputs": {"seed": 7, "steps": 20, "positive": ["4", 0], "negative": ["4", 1], "latent_image": ["4", 2]}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0]}},
        "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "fps": 16}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0]}},
        "10": {"class_type": "PreviewImage", "inputs": {"images": ["1", 0]}},
    }


def t2i():
    return {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "a lighthouse at dusk", "clip": ["9", 0]}},
        "2": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 8, "positive": ["1", 0], "negative": ["1", 0], "latent_image": ["2", 0]}},
        "4": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0]}},
        "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0]}},
    }


def spec(**kw):
    return {"label": "Test", "media": [], "prompt": None, "params": [], **kw}


def test_analysis_reads_the_graph_and_only_suggests():
    a = builder.analyze(wan_i2v(), INFO)
    assert a["mode"] == "motion" and a["outputs"] == ["8"]  # the Save node, not the Preview
    assert [r["node"] for r in a["results"]] == ["8", "10"]
    assert a["prompt"] == {"node": "2", "input": "text"}  # the one text that ends up positive
    assert [m["slot"] for m in a["media"]] == ["image:1"]
    # It takes a photo, so no output size is suggested; the canvas node is listed for the author to pick.
    assert a["size"] is None and [s["node"] for s in a["sizes"]] == ["4"]
    length = next(p for p in a["params"] if p["input"] == "length")
    assert length["step"] == 4  # ComfyUI's own step: 4n+1 frames stay valid


def test_two_positive_prompts_mean_the_author_picks():
    wf = wan_i2v()
    wf["11"] = {"class_type": "CLIPTextEncode", "inputs": {"text": "second positive", "clip": ["9", 0]}}
    wf["12"] = {"class_type": "WanImageToVideo", "inputs": {"positive": ["11", 0], "negative": ["3", 0], "start_image": ["1", 0],
                                                            "width": 8, "height": 8, "length": 1}}
    wf["13"] = {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 1, "positive": ["12", 0], "negative": ["12", 1], "latent_image": ["12", 2]}}
    wf["14"] = {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0]}}
    wf["15"] = {"class_type": "SaveImage", "inputs": {"images": ["14", 0]}}
    a = builder.analyze(wf, INFO)
    assert a["prompt"] is None and any("Pick the one people write in" in n for n in a["notes"])


def test_a_file_name_setting_can_become_an_input_but_isnt_by_default():
    wf = wan_i2v()
    wf["1"] = {"class_type": "LoadImageFromPath", "inputs": {"path": "C:/in/face.jpg"}}
    a = builder.analyze(wf, INFO)
    m = a["media"][0]
    assert (m["kind"], m["found"], m["suggested"]) == ("image", "setting", False)
    assert not any(p["input"] == "path" for p in a["params"])
    data = builder.assemble_local(spec(media=[{"node": "1", "input": "path", "kind": "image"}]), {"workflow": a["workflow"]}, INFO)
    assert data["workflow"]["1"]["inputs"]["path"] == "{{image:1}}"


def test_nothing_undeclared_is_written():
    a = builder.analyze(wan_i2v(), INFO)
    data = builder.assemble_local(spec(media=[{"node": "1", "input": "image", "kind": "image"}], prompt={"node": "2", "input": "text", "default": "turn"}),
                                  {"workflow": a["workflow"]}, INFO)
    data["id"] = "wan"
    e = engines.load_template(data)
    wf = e.build({"inputs": [{"slot": "image:1"}], "prompt": "wave", "params": {"aspect": "9:16", "out_size": "1.5 MP"}})
    # Only the photo and the prompt change. The canvas, frame count, seed and negative stay as the workflow has them.
    before = a["workflow"]
    changed = {(n, k) for n in before for k, v in before[n]["inputs"].items() if wf[n]["inputs"].get(k) != v}
    assert changed == {("1", "image"), ("2", "text")}
    assert set(wf) == set(before)  # no node added or removed: the Preview still runs
    assert e.outputs == ["8"] and "canvas" not in e.size


def test_a_declared_output_size_is_written_where_the_author_put_it():
    a = builder.analyze(t2i(), INFO)
    assert a["size"] == {"node": "2"}  # no file in, one place to set a size: suggested
    data = builder.assemble_local(spec(prompt={"node": "1", "input": "text", "default": "x"}, size={"node": "2"}), {"workflow": a["workflow"]}, INFO)
    out = next(f for f in data["inputs"] if f["type"] == "size")
    assert out["aspect"] == "1:1" and out["default"] == "1 MP"  # read from the node's 1024x1024
    data["id"] = "t2i"
    e = engines.load_template(data)
    assert e.size["canvas"]["aspect"] == "1:1" and not any(p["key"] == "size" for p in e.params)
    wf = e.build({"inputs": [], "prompt": "x", "params": {"aspect": "16:9", "out_size": "2 MP"}})
    w, h = wf["2"]["inputs"]["width"], wf["2"]["inputs"]["height"]
    assert w / h == pytest.approx(16 / 9, rel=0.03) and w * h == pytest.approx(2e6, rel=0.12) and wf["2"]["inputs"]["batch_size"] == 1


def test_size_needs_a_width_and_height_and_owns_them():
    a = builder.analyze(t2i(), INFO)
    with pytest.raises(builder.BuildError, match="width and a height"):
        builder.assemble_local(spec(size={"node": "3"}), {"workflow": a["workflow"]}, INFO)
    with pytest.raises(builder.BuildError, match="take them out of the settings"):
        builder.assemble_local(spec(size={"node": "2"}, params=[{"node": "2", "input": "width", "type": "int"}]), {"workflow": a["workflow"]}, INFO)


def test_the_result_node_is_the_authors_pick():
    a = builder.analyze(wan_i2v(), INFO)
    assert builder.assemble_local(spec(outputs=["10"]), {"workflow": a["workflow"]}, INFO)["outputs"] == ["10"]
    with pytest.raises(builder.BuildError, match="image or video a run keeps"):
        builder.assemble_local(spec(outputs=["5"]), {"workflow": a["workflow"]}, INFO)


def test_clip_limits_exist_only_when_declared():
    wf = wan_i2v()
    wf["20"] = {"class_type": "VHS_LoadVideo", "inputs": {"video": "clip.mp4", "force_rate": 16, "frame_load_cap": 81}}
    wf["4"]["inputs"]["start_image"] = ["20", 0]
    a = builder.analyze(wf, INFO)
    row = {"node": "20", "input": "video", "kind": "video"}
    v = builder.assemble_local(spec(media=[row]), {"workflow": a["workflow"]}, INFO)["inputs"][0]
    assert "window" not in v and "fps" not in v and "max_height" not in v
    v = builder.assemble_local(spec(media=[{**row, "window": [1, 5], "fps": [16, 16]}]), {"workflow": a["workflow"]}, INFO)["inputs"][0]
    assert v["window"] == [1.0, 5.0] and v["fps"] == [16.0, 16.0]
    with pytest.raises(builder.BuildError, match="clip length"):
        builder.assemble_local(spec(media=[{**row, "window": [5, 1]}]), {"workflow": a["workflow"]}, INFO)


def test_older_files_with_computed_sizes_load_as_a_declared_size():
    data = builder.assemble_local(spec(prompt={"node": "1", "input": "text", "default": "x"}), {"workflow": t2i()}, INFO)
    data.update(id="old", computed={"size.width": [["2", "width"]], "size.height": [["2", "height"]]},
                size={"multiple": 32, "aspect": "3:2", "default": "2 MP", "follows": "image:1"})
    e = engines.load_template(data)
    assert e.size["canvas"]["aspect"] == "3:2" and e.size["canvas"]["size"] == "2 MP" and e.bindings["size"]
    wf = e.build({"inputs": [], "prompt": "x", "params": {}})
    assert wf["2"]["inputs"]["width"] / wf["2"]["inputs"]["height"] == pytest.approx(1.5, rel=0.03)


def test_a_template_can_take_more_than_one_clip():
    wf = wan_i2v()
    wf["20"] = {"class_type": "VHS_LoadVideo", "inputs": {"video": "a.mp4", "force_rate": 16, "frame_load_cap": 81}}
    wf["21"] = {"class_type": "VHS_LoadVideo", "inputs": {"video": "b.mp4", "force_rate": 16, "frame_load_cap": 81}}
    wf["4"]["inputs"]["start_image"] = ["20", 0]
    wf["10"]["inputs"]["images"] = ["21", 0]
    a = builder.analyze(wf, INFO)
    rows = [{"node": "20", "input": "video", "kind": "video", "label": "Motion", "window": [2, 8]},
            {"node": "21", "input": "video", "kind": "video", "label": "Background", "fps": [24, 24]}]
    data = builder.assemble_local(spec(media=rows), {"workflow": a["workflow"]}, INFO)
    data["id"] = "two"
    e = engines.load_template(data)
    assert [f["key"] for f in e.fields if f["type"] == "video"] == ["video:1", "video:2"]
    # Each clip keeps its own limits and its own file.
    assert engines.clip_limits(e, "video:1") == ((2.0, 8.0), (1.0, 60.0))
    assert engines.clip_limits(e, "video:2") == (None, (24.0, 24.0))
    assert engines.clip_file("video:1") == "driving/driving.mp4" and engines.clip_file("video:2") == "driving/driving-2.mp4"
    assert engines.poster_file("driving/driving-2.mp4") == "driving/poster-2.webp" and engines.poster_file("driving/driving.mp4") == "driving/poster.webp"
    wf2 = e.build({"inputs": [{"slot": "video:1"}, {"slot": "video:2"}], "prompt": "", "params": {}})
    assert wf2["20"]["inputs"]["video"] != wf2["21"]["inputs"]["video"]
    # Only the clip with a length limit is checked against it.
    engines.ENGINES["local/two"] = e
    try:
        w = engines.compose({"engine": "local/two", "mode": "motion", "prompt": "x", "params": {},
                             "inputs": [{"slot": "video:1", "duration": 12}, {"slot": "video:2", "duration": 30}]})["warnings"]
        assert [x["text"] for x in w if "Trim" in x["text"]] == ["Trim motion to 2–8 s (now 12.0 s)"]
    finally:
        engines.ENGINES.pop("local/two", None)
