"""Character Lab: characters the user keeps, and the RefMod each one is made into.

A character is a folder, ``<home>/characters/<id>/``: ``character.json`` (name, notes, which
photo is its face, which RefMod it was made into) and ``photos/``. Files are the record,
so a backup carries them like generations.

A RefMod is MiniMax H3's reference adapter (ComfyUI-MiniMaxH3Mod): the photos encoded once by
H3's video VAE, then loaded into any H3 run. ``start_refmod`` runs ``templates/lab/make-refmod.json``
on the local ComfyUI. ComfyUI saves it to its first registered ``refmods`` folder, which the
README has pointed at ``output/refmods``, so it comes back through ``/view`` like a result, and
lands in the RefMod folder (``paths.refmods_dir``) as ``<name>.safetensors``. That folder is the
list a template's RefMod input picks from, Lab-made or not. A run uploads the one it uses to
ComfyUI's ``input/refmods/openillusion/`` (``stage``).
"""

from __future__ import annotations

import asyncio
import copy
import json
import re
import shutil
import time
from pathlib import Path

import httpx

from . import local, media, paths, settings
from . import generation as sc

MAX_PHOTOS = 16  # Create H3 RefMod takes up to 16 stills
EXT = ".safetensors"
SUBFOLDER = "openillusion"  # under each refmods folder ComfyUI has
_ID = re.compile(r"^[0-9A-Z]{26}$")

_making: dict[str, dict] = {}  # id → {state: queued|running|failed, detail}, while a RefMod is made


def root() -> Path:
    return paths._ensure(paths.user_root() / "characters")


def folder(cid: str) -> Path:
    if not _ID.match(cid or ""):
        raise FileNotFoundError(cid)
    return root() / cid


def _read(cid: str) -> dict:
    p = folder(cid) / "character.json"
    if not p.is_file():
        raise FileNotFoundError(cid)
    return json.loads(p.read_text("utf-8"))


def _write(c: dict) -> None:
    paths.write_atomic(folder(c["id"]) / "character.json", json.dumps(c, indent=2, ensure_ascii=False) + "\n")


def refmod_file(name: str) -> Path:
    """A RefMod in the RefMod folder, by file name. Nothing outside it."""
    base = paths.refmods_dir().resolve()
    p = (base / str(name or "")).resolve()
    if p.parent != base or p.suffix.lower() != EXT or not p.is_file():
        raise FileNotFoundError(name)
    return p


def refmod_path(cid: str) -> Path:
    """Where this character's RefMod is (it may be gone: deleted or renamed in the folder)."""
    return paths.refmods_dir() / ((_read(cid).get("refmod") or {}).get("file") or f"{cid}{EXT}")


def list_refmods() -> list[dict]:
    """Every RefMod in the RefMod folder, newest first. The ones Character Lab made say whose."""
    made = {c["refmod"]["file"]: c for c in list_all() if c["refmod"]}
    out = []
    for p in paths.refmods_dir().iterdir():
        if p.suffix.lower() != EXT or not p.is_file():
            continue
        st, c = p.stat(), made.get(p.name)
        out.append({"name": p.name, "label": p.stem, "bytes": st.st_size, "modified": st.st_mtime,
                    "character": {"id": c["id"], "name": c["name"], "cover": c["cover"], "face": c["photo_urls"].get(c["cover"] or "")} if c else None})
    return sorted(out, key=lambda r: r["modified"], reverse=True)


def _file_name(c: dict) -> str:
    """The file a character's RefMod is saved as: the one it has in the folder, else its name, made unique."""
    old = (c.get("refmod") or {}).get("file")
    if old and (paths.refmods_dir() / old).is_file():
        return old
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", c["name"]).strip(" .-") or c["id"]
    name, n = f"{stem}{EXT}", 2
    while (paths.refmods_dir() / name).exists():
        name, n = f"{stem} {n}{EXT}", n + 1
    return name


def photo_path(cid: str, name: str) -> Path:
    base = (folder(cid) / "photos").resolve()
    p = (base / name).resolve()
    if p.parent != base or not p.is_file():
        raise FileNotFoundError(name)
    return p


def public(c: dict) -> dict:
    """What the browser sees: the record, file links, and whether the RefMod is current."""
    cid = c["id"]
    rm = c.get("refmod")
    if rm and not (paths.refmods_dir() / rm["file"]).is_file():
        rm = None
    return {
        **c, "refmod": rm,
        "photo_urls": {p: f"/api/characters/{cid}/photos/{p}" for p in c.get("photos", [])},
        # Photos added or removed since: the RefMod still works, but no longer shows all of them.
        "refmod_stale": bool(rm) and sorted(rm.get("photos") or []) != sorted(c.get("photos") or []),
        "making": _making.get(cid),
    }


def list_all() -> list[dict]:
    out = []
    for d in root().iterdir():
        try:
            out.append(public(_read(d.name)))
        except (FileNotFoundError, ValueError):
            continue
    return sorted(out, key=lambda c: c.get("created", 0), reverse=True)


def get(cid: str) -> dict:
    return public(_read(cid))


def _clean_name(v) -> str:
    v = str(v or "").strip()
    if not v:
        raise ValueError("Give the character a name")
    return v[:60]


def create(name: str, notes: str = "") -> dict:
    c = {"id": sc.new_id(), "name": _clean_name(name), "notes": str(notes or "")[:1000], "created": time.time(),
         "photos": [], "cover": None, "refmod": None}
    (folder(c["id"]) / "photos").mkdir(parents=True, exist_ok=True)
    _write(c)
    return public(c)


def update(cid: str, **ch) -> dict:
    c = _read(cid)
    if "name" in ch:
        c["name"] = _clean_name(ch["name"])
    if "notes" in ch:
        c["notes"] = str(ch["notes"] or "")[:1000]
    if "cover" in ch:
        if ch["cover"] not in c["photos"]:
            raise ValueError("That photo isn't this character's")
        c["cover"] = ch["cover"]
    _write(c)
    return public(c)


def delete(cid: str) -> None:
    """The character goes; its RefMod stays in the RefMod folder, where templates can still pick it."""
    if cid in _making and _making[cid]["state"] != "failed":
        raise ValueError("Wait for its RefMod to finish")
    d = folder(cid)
    if not (d / "character.json").is_file():
        raise FileNotFoundError(cid)
    shutil.rmtree(d)
    _making.pop(cid, None)


def add_photo(cid: str, src: Path) -> dict:
    """Copy a photo in, upright, without its EXIF when Settings says so."""
    c = _read(cid)
    if len(c["photos"]) >= MAX_PHOTOS:
        raise ValueError(f"A character takes up to {MAX_PHOTOS} photos")
    img = media.open_image(src)
    if settings.load().get("strip_exif", True):
        img = media.strip_exif(img)
    n = 1 + max([int(m.group(1)) for p in c["photos"] if (m := re.match(r"p-(\d+)", p))], default=0)
    dst = media.save_image(img, folder(cid) / "photos" / f"p-{n:02d}")
    c["photos"].append(dst.name)
    c["cover"] = c["cover"] or dst.name
    _write(c)
    return public(c)


def remove_photo(cid: str, name: str) -> dict:
    c = _read(cid)
    if name not in c["photos"]:
        raise FileNotFoundError(name)
    photo_path(cid, name).unlink()
    c["photos"].remove(name)
    if c["cover"] == name:
        c["cover"] = c["photos"][0] if c["photos"] else None
    _write(c)
    return public(c)


# ---- making the RefMod ---------------------------------------------------------------


def lab_workflow() -> dict:
    return json.loads((paths.repo_root() / "templates" / "lab" / "make-refmod.json").read_text("utf-8"))


def refmod_workflow(cid: str, uploaded: list[str]) -> dict:
    """make-refmod.json with one photo loader per photo, saving as ``openillusion/<id>``."""
    lab = lab_workflow()
    wf = copy.deepcopy(lab["workflow"])
    node, photo = lab["node"], lab["photo"]
    loader = wf.pop(photo)
    wf[node]["inputs"]["name"] = cid
    for i, name in enumerate(uploaded):
        nid = str(int(photo) + i)
        wf[nid] = {**copy.deepcopy(loader), "inputs": {**loader["inputs"], "image": name}}
        wf[node]["inputs"][f"refs_image.ref_image_{i}"] = [nid, 0]
    return wf


def start_refmod(cid: str) -> dict:
    c = _read(cid)
    if not c["photos"]:
        raise ValueError("Add a photo of the character first")
    if (_making.get(cid) or {}).get("state") in ("queued", "running"):
        return public(c)
    _making[cid] = {"state": "queued", "detail": "Sending the photos to your ComfyUI"}
    asyncio.get_running_loop().create_task(_make(cid))
    return public(c)


async def _make(cid: str, comfy: local.ComfyUI | None = None, poll: float = 1.0) -> None:
    comfy = comfy or local.ComfyUI()
    try:
        c = _read(cid)
        photos = list(c["photos"])
        lab = lab_workflow()
        info = await comfy.object_info(fresh=True)
        check = local.check(refmod_workflow(cid, ["x.png"]), info, lab.get("hints"))
        if check["missing_nodes"] or check["missing_models"]:
            raise RuntimeError(local.check_message(check) + (" · install ComfyUI-MiniMaxH3Mod (see README)" if check["missing_nodes"] else ""))
        uploaded = [await comfy.upload_input(photo_path(cid, p), f"{cid}-{p}", SUBFOLDER) for p in photos]
        pid = await comfy.queue(refmod_workflow(cid, uploaded))
        _making[cid] = {"state": "running", "detail": "Encoding in your ComfyUI"}
        while (h := await comfy.history(pid)) is None:
            await asyncio.sleep(poll)
        status = h.get("status") or {}
        if status.get("status_str") != "success":
            last = next((m[1] for m in reversed(status.get("messages") or []) if m[0] == "execution_error"), {})
            raise RuntimeError(f"ComfyUI failed · {last.get('exception_message') or status.get('status_str') or 'no reason given'}".strip())
        details = {}
        for out in (h.get("outputs") or {}).values():
            for t in out.get("text") or []:
                try:
                    details = json.loads(t)
                except (TypeError, ValueError):
                    continue
        data = await comfy.output_file(f"{cid}.safetensors", f"refmods/{SUBFOLDER}")
        if not data:
            raise RuntimeError("ComfyUI made the RefMod but it isn't in output/refmods. Add the refmods line to extra_model_paths.yaml (see README).")
        c = _read(cid)
        dst = paths.refmods_dir() / _file_name(c)
        tmp = dst.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(dst)
        c["refmod"] = {"file": dst.name, "sha256": sc.sha256_file(dst), "bytes": len(data), "made": time.time(),
                       "photos": photos, "tokens": details.get("tokens"), "mode": lab["workflow"][lab["node"]]["inputs"]["mode"]}
        _write(c)
        _making.pop(cid, None)
    except httpx.TransportError:
        _making[cid] = {"state": "failed", "detail": f"Nothing answers at {comfy.base}. Start ComfyUI, or fix the address in Settings → Local."}
    except Exception as e:  # shown on the character; Make again retries
        _making[cid] = {"state": "failed", "detail": str(e) or e.__class__.__name__}


# ---- using it in a run -----------------------------------------------------------------


def mod_name(sha256: str) -> str:
    """What a run's RefMod is called in ComfyUI: by content, so the same file uploads once."""
    return f"{SUBFOLDER}/{sha256[:16]}"


async def stage(comfy: local.ComfyUI, path: Path, sha256: str) -> str:
    """Put a run's RefMod in ComfyUI's ``input/refmods/openillusion/``; returns the loader's name for it."""
    name = mod_name(sha256)
    await comfy.upload_input(path, name.split("/")[-1] + ".safetensors", f"refmods/{SUBFOLDER}")
    return name
