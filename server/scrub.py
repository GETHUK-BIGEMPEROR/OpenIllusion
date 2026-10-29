"""Files as they leave the library: the picture or sound, without what was written around it.

Cameras, phones and editors stamp files with when and where they were made (EXIF dates and GPS,
PNG text and time chunks, an mp4's creation time, a WebM's date, ID3 and RIFF tags). A template
or a generation shared from OpenIllusion goes out without them. Nothing is re-encoded: the
stamps are cut out, or zeroed in place where cutting would move the media. A photo turned by its
EXIF orientation is the one exception: it is turned for real first, since the turn goes with the
EXIF. A file that doesn't parse as its type is passed through as it was. Ogg is left as it is.
"""

from __future__ import annotations

import io
import struct

from PIL import Image, ImageOps


def clean(data: bytes, name: str, keep_tags: bool = False) -> bytes:
    """``data`` without its dates and tags, by ``name``'s type. ``keep_tags`` keeps an mp4's tags
    (OpenIllusion's recipe rides in its comment) and only zeroes its times."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    try:
        if ext in ("jpg", "jpeg", "png", "webp"):
            data = _upright(data, ext)
        if ext in ("jpg", "jpeg"):
            return _jpeg(data)
        if ext == "png":
            return _png(data)
        if ext == "webp":
            return _riff(data, b"WEBP", {b"EXIF", b"XMP "})
        if ext == "wav":
            return _riff(data, b"WAVE", {b"LIST", b"id3 ", b"ID3 ", b"bext", b"iXML", b"XMP "})
        if ext in ("mp4", "mov", "m4v", "m4a"):
            return _mp4(data, keep_tags)
        if ext == "webm":
            return _webm(data)
        if ext in ("mp3", "aac"):
            return _id3(data)
        if ext == "flac":
            return _flac(data)
    except (ValueError, IndexError, struct.error, OSError):
        pass
    return data


# ---- pictures ---------------------------------------------------------------------


def _upright(data: bytes, ext: str) -> bytes:
    """A photo its EXIF says to turn, turned for real, so dropping the EXIF doesn't tip it over."""
    with Image.open(io.BytesIO(data)) as img:
        if img.getexif().get(0x0112, 1) in (None, 1) or getattr(img, "n_frames", 1) > 1:
            return data
        turned = ImageOps.exif_transpose(img)
        buf = io.BytesIO()
        if ext == "png":
            turned.save(buf, "PNG")
        elif ext == "webp":
            turned.save(buf, "WEBP", quality=95)
        else:
            turned.convert("RGB").save(buf, "JPEG", quality=95, icc_profile=img.info.get("icc_profile"))
        return buf.getvalue()


def _jpeg(b: bytes) -> bytes:
    """Drop APP1 (EXIF, XMP), APP13 (IPTC) and comments; the colour profile and the image stay."""
    if b[:2] != b"\xff\xd8":
        return b
    out, i = bytearray(b[:2]), 2
    while i + 4 <= len(b):
        if b[i] != 0xFF:
            return b
        m = b[i + 1]
        if m == 0xFF:
            i += 1
            continue
        if m in (0xDA, 0xD9):  # the image data starts: the rest is pixels
            return bytes(out + b[i:])
        if 0xD0 <= m <= 0xD7 or m == 0x01:
            out += b[i:i + 2]
            i += 2
            continue
        n = int.from_bytes(b[i + 2:i + 4], "big")
        if m not in (0xE1, 0xED, 0xFE):
            out += b[i:i + 2 + n]
        i += 2 + n
    return b


_PNG = b"\x89PNG\r\n\x1a\n"


def _png(b: bytes) -> bytes:
    """Drop text, time and EXIF chunks."""
    if not b.startswith(_PNG):
        return b
    out, i = bytearray(_PNG), len(_PNG)
    while i + 12 <= len(b):
        n = int.from_bytes(b[i:i + 4], "big")
        kind = b[i + 4:i + 8]
        if kind not in (b"tEXt", b"zTXt", b"iTXt", b"tIME", b"eXIf"):
            out += b[i:i + 12 + n]
        i += 12 + n
        if kind == b"IEND":
            return bytes(out)
    return b


def _riff(b: bytes, form: bytes, drop: set[bytes]) -> bytes:
    """A RIFF file (WebP, WAV) without the chunks in ``drop``; a WebP's header stops pointing at them."""
    if b[:4] != b"RIFF" or b[8:12] != form:
        return b
    out, i = bytearray(), 12
    while i + 8 <= len(b):
        kind, n = b[i:i + 4], int.from_bytes(b[i + 4:i + 8], "little")
        whole = b[i:i + 8 + n + (n & 1)]
        if kind == b"VP8X" and n >= 1:
            whole = bytearray(whole)
            whole[8] &= ~0x0C & 0xFF  # no EXIF, no XMP
        if kind not in drop:
            out += whole
        i += 8 + n + (n & 1)
    return b"RIFF" + struct.pack("<I", len(out) + 4) + form + bytes(out)


# ---- video ------------------------------------------------------------------------

_XMP_UUID = bytes.fromhex("BE7ACFCB97A942E89C71999491E3AFAC")
_CONTAINERS = {b"moov", b"trak", b"mdia", b"edts", b"minf"}
_TIMED = {b"mvhd", b"tkhd", b"mdhd"}


def _mp4(data: bytes, keep_tags: bool) -> bytes:
    """Zero every creation and change time, and blank the tag boxes (``udta``, ``meta``, XMP) by
    renaming them ``free``: same size, so the offsets into the media stay right."""
    b = bytearray(data)

    def walk(start: int, end: int) -> None:
        i = start
        while i + 8 <= end:
            size, kind, head = int.from_bytes(b[i:i + 4], "big"), bytes(b[i + 4:i + 8]), 8
            if size == 1:
                size, head = int.from_bytes(b[i + 8:i + 16], "big"), 16
            elif size == 0:
                size = end - i
            if size < head or i + size > end:
                raise ValueError("bad box")
            body = i + head
            if kind in _TIMED:
                w = 8 if b[body] == 1 else 4
                b[body + 4:body + 4 + 2 * w] = bytes(2 * w)
            elif kind in _CONTAINERS:
                walk(body, i + size)
            elif not keep_tags and (kind in (b"udta", b"meta") or (kind == b"uuid" and b[body:body + 16] == _XMP_UUID)):
                b[i + 4:i + 8] = b"free"
            i += size

    if data[4:8] not in (b"ftyp", b"moov", b"mdat", b"free", b"wide", b"skip"):
        return data
    walk(0, len(b))
    return bytes(b)


def _vint(b: bytes, i: int) -> tuple[int, int]:
    """An EBML variable-length number at ``i``: (value, its length). All ones means unknown size."""
    first = b[i]
    n = 1
    while n <= 8 and not first & (0x80 >> (n - 1)):
        n += 1
    if n > 8:
        raise ValueError("bad vint")
    v = first & (0xFF >> n)
    for k in range(1, n):
        v = (v << 8) | b[i + k]
    return (-1 if v == (1 << (7 * n)) - 1 else v), n


def _ebml_id(b: bytes, i: int) -> tuple[int, int]:
    first, n = b[i], 1
    while n <= 4 and not first & (0x80 >> (n - 1)):
        n += 1
    return int.from_bytes(b[i:i + n], "big"), n


_SEGMENT, _INFO, _DATE, _TAGS, _CLUSTER = 0x18538067, 0x1549A966, 0x4461, 0x1254C367, 0x1F43B675


def _webm(data: bytes) -> bytes:
    """Zero the Segment's DateUTC and turn its Tags into Void, in place."""
    b = bytearray(data)
    if b[:4] != b"\x1a\x45\xdf\xa3":
        return data
    i = 0
    while i < len(b):
        eid, n = _ebml_id(b, i)
        size, m = _vint(b, i + n)
        body = i + n + m
        if eid == _SEGMENT:
            j = body
            end = len(b) if size < 0 else body + size
            while j < end:
                cid, cn = _ebml_id(b, j)
                csize, cm = _vint(b, j + cn)
                cbody = j + cn + cm
                if csize < 0:
                    break
                if cid == _INFO:
                    k = cbody
                    while k < cbody + csize:
                        did, dn = _ebml_id(b, k)
                        dsize, dm = _vint(b, k + dn)
                        if did == _DATE:
                            b[k + dn + dm:k + dn + dm + dsize] = bytes(dsize)
                        k += dn + dm + dsize
                elif cid == _TAGS and cn + cm + csize >= 9:
                    whole = cn + cm + csize
                    b[j:j + whole] = b"\xec\x01" + (whole - 9).to_bytes(7, "big") + bytes(whole - 9)
                j = cbody + csize
            return bytes(b)
        if size < 0:
            break
        i = body + size
    return bytes(b)


# ---- sound ------------------------------------------------------------------------


def _id3(b: bytes) -> bytes:
    """Drop an ID3v2 tag at the start and an ID3v1 tag at the end."""
    if b[:3] == b"ID3" and len(b) > 10:
        n = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]
        b = b[10 + n + (10 if b[5] & 0x10 else 0):]
    if len(b) >= 128 and b[-128:-125] == b"TAG":
        b = b[:-128]
    return b


def _flac(b: bytes) -> bytes:
    """Drop the Vorbis comment block (titles, dates, encoder)."""
    if b[:4] != b"fLaC":
        return b
    blocks, i = [], 4
    while True:
        head = b[i]
        n = int.from_bytes(b[i + 1:i + 4], "big")
        if head & 0x7F != 4:
            blocks.append(bytearray(b[i:i + 4 + n]))
        i += 4 + n
        if head & 0x80:
            break
    for blk in blocks:
        blk[0] &= 0x7F
    blocks[-1][0] |= 0x80
    return b"fLaC" + b"".join(blocks) + b[i:]
