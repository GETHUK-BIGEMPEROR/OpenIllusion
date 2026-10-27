import json
import sys
from fractions import Fraction
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import engines, paths, store  # noqa: E402

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    paths.configure(tmp_path / "user", tmp_path / "output")
    store._conn = None
    monkeypatch.delenv("COMFY_API_KEY", raising=False)
    yield tmp_path
    if store._conn is not None:
        store._conn.close()
        store._conn = None


def make_video(path: Path, seconds: float = 3.0, fps: int = 24, size=(320, 240)) -> Path:
    import av
    import numpy as np

    with av.open(str(path), "w", format="mp4") as c:
        s = c.add_stream("libx264", rate=fps)
        s.width, s.height = size
        s.pix_fmt = "yuv420p"
        for n in range(int(seconds * fps)):
            arr = np.zeros((size[1], size[0], 3), dtype=np.uint8)
            arr[:, :, 0] = (n * 7) % 255
            arr[:, : (n * 5) % size[0], 1] = 200
            f = av.VideoFrame.from_ndarray(arr, format="rgb24")
            f.pts = n
            f.time_base = Fraction(1, fps)
            for p in s.encode(f):
                c.mux(p)
        for p in s.encode():
            c.mux(p)
    return path


def make_image(path: Path, size=(512, 384), color=(200, 80, 40)) -> Path:
    from PIL import Image

    Image.new("RGB", size, color).save(path)
    return path


@pytest.fixture
def video(tmp_path):
    return make_video(tmp_path / "clip.mp4")


@pytest.fixture
def image(tmp_path):
    return make_image(tmp_path / "ref.png")


@pytest.fixture
def fixture_templates(monkeypatch):
    """Workflows that exercise the local engine (pruning, casts, video output). Test-only, not shipped."""
    d = FIX / "templates"
    for f in sorted(d.glob("*.json")):
        e = engines.load_template(json.loads(f.read_text("utf-8")), base=d)
        monkeypatch.setitem(engines.ENGINES, e.id, e)


CLIP = "cloud/test-clip"


@pytest.fixture
def clip_template(monkeypatch):
    """A Router template that takes a photo and a clip: images[0] and video_url, as data URIs."""
    data = {
        "format": "openillusion.template", "version": 2, "id": "test-clip", "kind": "cloud", "mode": "motion",
        "label": "Test clip", "model": "acme/clip-model", "provider": "acme",
        "body": {"prompt": "", "images": ["{{image:1}}"], "video_url": "{{video:1}}"},
        "inputs": [
            {"key": "image:1", "type": "image", "required": True, "bind": [["images", 0]]},
            {"key": "video:1", "type": "video", "required": True, "bind": [["video_url"]]},
            {"key": "prompt", "type": "text", "required": True, "bind": [["prompt"]]},
        ],
        "result": [],
    }
    e = engines.load_template(data)
    e.data = data
    monkeypatch.setitem(engines.ENGINES, e.id, e)
    return e
