# OpenIllusion

Motion + Edit studio for Comfy. Run templates on Comfy Router with an API key,
or on your own GPU through Comfy API v2 (comfy-api-proxy in front of ComfyUI).

## Layout

```
openillusion/   Python package: aiohttp server + API (python -m openillusion)
ui/             React + Vite app; builds into openillusion/static
tests/          pytest suite
schema/         generation.v1.json (python -m openillusion.gen_schema)
```

## Run

```
py -m venv .venv
.venv\Scripts\python -m pip install -e .[dev]
cd ui && npm install && npm run build && cd ..
.venv\Scripts\python -m openillusion --open
```

The app serves on http://127.0.0.1:7870.

## Develop

```
.venv\Scripts\python -m pytest -q      # backend tests
cd ui && npx tsc --noEmit -p .         # typecheck
cd ui && npm run build                 # rebuild the UI
```
