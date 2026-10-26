"""OpenIllusion: a Motion + Edit studio for Comfy, in the cloud or on your own GPU."""

import os

# aiohttp's sendfile path (TransmitFile on Windows) can send the headers and then an
# empty body, so every image and clip on a page hangs or comes back blank. Plain
# chunked reads are fast enough for local files. Set before aiohttp is imported.
if os.name == "nt":
    os.environ.setdefault("AIOHTTP_NOSENDFILE", "1")

__version__ = "0.2.0"
