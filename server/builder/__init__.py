"""Template builder: turn a ComfyUI workflow or a Router model into a template.

Local: the user drops a workflow (UI or API JSON, or a PNG/WebP/MP4 ComfyUI
saved, which carries the API graph). UI graphs are converted to API format
against ``/object_info``, subgraphs flattened. ``analyze`` then lists what a
template could expose: media loaders, prompt boxes and widget values.

Cloud: a model's request schema is split the same way: prompt, media fields
and params.

Either way the browser picks what to expose and ``assemble`` writes the
template file. Nothing here runs a workflow or installs anything.

The package: ``workflow`` reads dropped files into an API graph, ``analysis`` lists what
it could expose, ``assemble`` writes the template file.
"""

from __future__ import annotations

from .workflow import BuildError, read_workflow, ui_to_api
from .analysis import output_kind, result_nodes, other_outputs, reachable, analyze
from .assemble import put_draft, get_draft, slugify, media_rows, assemble_local, assemble_cloud, preset, cloud_preset, inherit, save

__all__ = [
    "BuildError", "read_workflow", "ui_to_api", "output_kind", "result_nodes", "other_outputs",
    "reachable", "analyze", "put_draft", "get_draft", "slugify", "media_rows", "assemble_local",
    "assemble_cloud", "preset", "cloud_preset", "inherit", "save",
]
