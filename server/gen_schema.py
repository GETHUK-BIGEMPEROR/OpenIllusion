"""Regenerate schema/generation.v1.json from the manifest model.

    python -m server.gen_schema
"""

import json

from . import paths
from .generation import json_schema

if __name__ == "__main__":
    out = paths.repo_root() / "schema" / "generation.v1.json"
    out.write_text(json.dumps(json_schema(), indent=2) + "\n", "utf-8")
    print(f"wrote {out}")
