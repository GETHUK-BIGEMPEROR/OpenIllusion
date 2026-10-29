# Contributing

The app, its docs and their split: [README.md](README.md) (what it is, setup),
[docs/APP.md](docs/APP.md) (screens, design rules), [ARCHITECTURE.md](ARCHITECTURE.md)
(code, runs, storage, API), [docs/TEMPLATES.md](docs/TEMPLATES.md) (templates, Builder,
adapters).

## Develop

```powershell
.venv\Scripts\python -m server --port 7870      # backend
npm --prefix ui run dev                          # Vite on :5178, HMR, proxies /api to :7870
.venv\Scripts\python -m pytest -q                # tests
npx --prefix ui tsc -p ui/tsconfig.json --noEmit # typecheck
.venv\Scripts\python -m server.gen_schema        # regenerate schema/generation.v1.json
```

Conventions:

- **Docs in the same commit.** A change to a screen or a design rule updates
  `docs/APP.md`; to the architecture, storage, the API or a phase, `ARCHITECTURE.md`;
  to the template contract, the roles or an adapter's model, `docs/TEMPLATES.md`;
  to setup or the shipped templates, `README.md`.
- **No guessing from schemas at run time.** A model's behaviour lives in its
  adapter file, written from its docs.
- **Secrets stay off the server's disk.** The API key and proxy token live in the
  browser's storage and the server's memory; the server never sends them back, and
  never writes them into a settings file, a generation or a backup. A CSP runs only
  the app's own bundle, so a script that got in couldn't send the key anywhere.
- **Networking is the deployer's.** https, reverse proxies, logins and who can reach
  the port are left to whoever runs it; the app only refuses cross-origin writes.
- **Nothing installs itself.** Missing ComfyUI nodes and models are listed, never
  installed.
- **Tests fake the network.** Router, Comfy Cloud and ComfyUI are `httpx`
  mock transports; no test needs a key or a GPU.
