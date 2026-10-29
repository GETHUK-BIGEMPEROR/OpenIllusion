"""The generation manifest (format openillusion.generation, version 1).

A generation folder on disk has the same layout as a ``.illusion`` bundle, so
export is a zip of the folder and import is an unzip into one:

    generation.json  refs/ref-01.webp  driving/driving.mp4 (driving-2.mp4, ... for more clips)
    result/preview.mp4  result/poster.webp  comfy/workflow.json  LICENSES.md
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import paths

FORMAT = "openillusion.generation"
VERSION = 1

ROLES = ("character", "outfit", "location", "style", "product", "motion", "base", "edit")
LICENSES = ("own-footage", "own-image", "generated", "cc0", "cc-by", "licensed", "unknown")
OUTCOMES = ("worked", "partly", "didnt")

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _crockford(n: int) -> str:
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[n & 31])
        n >>= 5
    return "".join(reversed(out))


def new_id() -> str:
    """A ULID: 48-bit millisecond time + 80 random bits, Crockford base32."""
    return _crockford((int(time.time() * 1000) << 80) | secrets.randbits(80))


def share_id(generation_id: str) -> str:
    """The id a generation goes out under. A ULID starts with the time it was made; this is a hash
    of it instead, the same every time, so adding your own share back is still spotted."""
    return _crockford(int.from_bytes(hashlib.sha256(b"openillusion.share:" + generation_id.encode()).digest()[:16], "big"))


class _Open(BaseModel):
    # Unknown fields are kept and ignored, so newer generations still open.
    model_config = ConfigDict(extra="allow")


class Engine(_Open):
    kind: Literal["router", "local"] = "router"
    model: str
    provider: str | None = None
    schema_version: str | None = None


class InputItem(_Open):
    slot: str  # "image:1", "video:1"
    role: str = "character"
    file: str | None = None
    sha256: str | None = None
    license: str = "unknown"
    contains_person: bool = False
    consent: bool = False
    thumb: str | None = None  # data URI, Recipe-only generations
    url: str | None = None  # public URL for URL-only engines
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    trim: list[float] | None = None
    label: str | None = None
    prep: dict | None = None  # how the image was cropped and sized for the run: {source, box, width, height}


class Result(_Open):
    file: str | None = None
    poster: str | None = None
    kind: Literal["image", "video"] | None = None
    seed: int | None = None
    cost_reported: str | None = None  # older runs only; usage lives in the Comfy dashboard
    elapsed: float | None = None
    provider: str | None = None
    output_file: str | None = None  # path under ComfyUI output, machine-local
    error: dict | None = None


class Lineage(_Open):
    forked_from: str | None = None
    parent: str | None = None  # variant group
    chain: list[str] = Field(default_factory=list)
    sent_to: list[str] = Field(default_factory=list)


class Attest(_Open):
    sfw: bool = False
    rights: bool = False


class Manifest(_Open):
    format: Literal["openillusion.generation"] = FORMAT
    version: int = VERSION
    id: str
    title: str = "Untitled generation"
    mode: Literal["motion", "edit"]
    created: float = Field(default_factory=time.time)
    engine: Engine
    inputs: list[InputItem] = Field(default_factory=list)
    prompt: str = ""
    params: dict[str, Any] = Field(default_factory=dict)
    request_template: dict[str, Any] = Field(default_factory=dict)
    result: Result | None = None
    status: Literal["draft", "running", "done", "failed", "moderated", "cancelled"] = "draft"
    outcome: Literal["worked", "partly", "didnt"] | None = None
    notes: str = ""
    tags: list[str] = Field(default_factory=list)
    starred: bool = False
    lineage: Lineage = Field(default_factory=Lineage)
    attest: Attest = Field(default_factory=Attest)
    variant: Literal["full", "light", "recipe"] | None = None


class ManifestError(ValueError):
    def __init__(self, errors: list[dict]):
        super().__init__("; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in errors))
        self.errors = errors


def parse(data: dict | str | bytes) -> tuple[Manifest, list[str]]:
    """Validate a manifest. Returns it plus the unknown top-level fields."""
    if isinstance(data, (str, bytes)):
        data = json.loads(data)
    if not isinstance(data, dict):
        raise ManifestError([{"loc": ["$"], "msg": "manifest must be a JSON object"}])
    if data.get("format") != FORMAT:
        raise ManifestError([{"loc": ["format"], "msg": f"expected {FORMAT!r}"}])
    v = data.get("version")
    if not isinstance(v, int) or v < 1:
        raise ManifestError([{"loc": ["version"], "msg": "expected a positive integer"}])
    try:
        m = Manifest.model_validate(data)
    except ValidationError as e:
        raise ManifestError([{"loc": list(x["loc"]), "msg": x["msg"]} for x in e.errors()]) from None
    unknown = sorted(set(data) - set(Manifest.model_fields))
    return m, unknown


def dump(m: Manifest) -> dict:
    return m.model_dump(mode="json", exclude_none=False)


# What a generation leaves behind when it goes out (an export, a link, the recipe in a result
# file): when it was made, what it came from, and your star and verdict on it.
PRIVATE = ("created", "lineage", "starred", "outcome")


def shareable(m: Manifest) -> dict:
    """``m`` as it leaves the library: as it is, without its history (``PRIVATE``) or a dated id."""
    d = dump(m)
    for k in PRIVATE:
        d.pop(k, None)
    d["id"] = share_id(m.id)
    if d.get("result"):
        d["result"].pop("output_file", None)
    return d


def read(folder: Path) -> Manifest:
    m, _ = parse((folder / "generation.json").read_text("utf-8"))
    return m


def write(folder: Path, m: Manifest) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    paths.write_atomic(folder / "generation.json", json.dumps(dump(m), indent=2, ensure_ascii=False))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def licenses_md(m: Manifest) -> str:
    lines = [f"# Licences for “{m.title}”", "", f"Generation `{m.id}`, made with OpenIllusion.", ""]
    lines.append("| Slot | Role | File | Licence | Person on camera |")
    lines.append("| --- | --- | --- | --- | --- |")
    for i in m.inputs:
        person = "yes, consent given" if i.contains_person and i.consent else ("yes" if i.contains_person else "no")
        lines.append(f"| {i.slot} | {i.role} | {i.file or '(not included)'} | {i.license} | {person} |")
    if m.result and m.result.file:
        lines.append(f"| result | output | {m.result.file} | generated by {m.engine.model} | — |")
    lines.append("")
    return "\n".join(lines)


def json_schema() -> dict:
    """The published JSON Schema, generated from the pydantic model."""
    s = Manifest.model_json_schema()
    s["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    s["$id"] = "urn:openillusion:generation:v1"
    s["title"] = "OpenIllusion generation manifest, version 1"
    return s
