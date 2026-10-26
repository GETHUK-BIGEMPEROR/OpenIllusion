# Motion & Edit Studio on ComfyUI — Build Plan + Design Handoff

Oct 23, 2026 · @Wang

> **Status (Oct 26, 2026):** the product shipped as **OpenIllusion**, a standalone Python + React web app, not a ComfyUI node pack. It runs local templates against ComfyUI and cloud templates through Comfy Router. The architecture and node-pack sections below are the original plan, kept for history.

## TL;DR

Build **OpenIllusion**: an open-source Motion + Edit studio that ships as a ComfyUI custom node pack, calls frontier models through Comfy Router with the user's own key, and turns every run into a shareable **scroll** — a portable bundle of references, prompt, model and settings that anyone can remix in the app or open directly in ComfyUI.

It does three things:

1. **Motion** — a driving video plus 1–8 reference images becomes a new video that keeps the motion, camera and timing (Higgsfield Genjutsu's Motion Transfer, rebuilt).
2. **Edit** — 1–10 images plus an instruction (and optional boxes drawn on the canvas) become an edited image, which can be sent straight into Motion as the new cast.
3. **Scrolls** — a local catalogue of past runs, and a file format to share them. No server, no accounts: the scroll travels as a file, a link, or embedded inside the output video itself.

Why it can win: Genjutsu-style apps hide the recipe behind presets and credits; OpenIllusion makes the recipe the product. The bundle format plus a ComfyUI "Load Scroll" node targets **Most Innovative** and **Most Viral**, while FLUX 3 as the edit core targets the **Built with FLUX** bonus. Deadline is **Oct 30, 9am PT** — seven days from today.

## Competition brief and compliance

The target is Comfy Org's [Open Source Higgsfield](https://comfy.org/open-source-higgsfield/) challenge: submissions close **Oct 30, 9am PT**, winners are announced Nov 6, and every entry is automatically considered for Best Overall. The brief names Genjutsu and Cinema Studio as apps worth rebuilding; Comfy's own reference app for this lane is [Openjutsu](https://comfy.org/hub/apps/openjutsu/) (swap a character in a video from one image).

What Higgsfield [Genjutsu](https://higgsfield.ai/genjutsu) does, so we know what we are rebuilding: it transforms an existing clip in two ways — transfer its motion into a new cast, location or look, or swap selected elements while the rest stays as filmed. It takes 3–30 s source videos and many reference images, and runs mostly off presets.

| Prize | Reward | Qualifier | Our play |
| --- | --- | --- | --- |
| Best Overall | $10,000 | Every entry | Polished end-to-end Motion + Edit + Scrolls |
| Most Innovative | RTX 5090 | Never-done app, novel node pack or use of ComfyUI; demo must say why it is innovative | Scroll bundle format, Load/Save Scroll nodes, recipe embedded in the output file |
| Most Viral | RTX 5090 | Delightful and made to be shared | Drop someone's output video into the app and it re-opens as a remixable recipe |
| Built with FLUX | $1,000 / $500 / $250 Flux credits | FLUX 3 is the core model | Edit Studio defaults to `bfl/flux-3-image` |
| Built with MiniMax H3 | $1,000 API credits | MiniMax H3 is the core model | Motion Studio defaults to `minimax/minimax-h3` |
| Open Weights Only | RTX 5090 | No partner nodes or closed APIs | Not targeted: Router is our primary path |
| VFX built with LTX | $2,000 | LTX is the core video model | Not targeted: LTX 2.5 on Router is text-to-video only |

Compliance checklist (from your rules plus the published page):

- [ ] Built with ComfyUI: the app ships as a ComfyUI custom node pack; partner models run through Comfy Router; the optional local engine runs through ComfyUI's own graph executor.
- [ ] Open-source license at repo root (MIT recommended), plus a THIRD\_PARTY.md listing every model and its license.
- [ ] Setup detail good enough for a stranger: install via `comfy node install` or git clone, key setup, a 5-minute first run, tested on Windows, macOS and Linux.
- [ ] ComfyUI workflow JSON files committed for every engine, openable in stock ComfyUI.
- [ ] Demo video names every external tool and model (Router models, ffmpeg, any LLM used for prompt help) and explains why the entry is innovative.
- [ ] Lawful and SFW, no unlicensed IP or likeness: seed scrolls use our own footage and consenting performers; no celebrities, no franchise characters.
- [ ] Accept the feature-with-credit grant to ComfyUI, Runpod, LTX, Black Forest Labs and MiniMax on the submission form.
- [ ] One submission per person; register on the [sign-up form](https://form.typeform.com/to/Ayn9Cwfj) now (the first 200 sign-ups get free credits).

## Principles and positioning

OpenIllusion is an instrument, not a vending machine: it never promises a result, it shows exactly what was sent and what came back, and it makes the next experiment one click away. Whether a prompt works is the user's craft; our job is a fast, honest loop.

1. **The recipe is visible.** Every run shows the model ID, provider, the exact request body, the pre-run cost estimate and the seed. A Raw tab lets power users edit the JSON directly.
2. **No hidden prompt magic.** We never silently rewrite a prompt. Helpers (reference role sentences, FLUX 3 box JSON) insert visible, editable text.
3. **Local-first, bring your own key.** It runs on the user's machine inside their ComfyUI with their Comfy API key. We host nothing and there are no accounts.
4. **Every run is a scroll.** Successes and failures are saved with all inputs; a failed recipe is worth sharing too.
5. **Model-agnostic by schema.** Forms are generated from Router's published per-model JSON schemas, so a new model shows up without a release.
6. **Remix over presets.** Presets are just scrolls other people made — open files, not a curated store.

|  | Higgsfield Genjutsu | OpenIllusion |
| --- | --- | --- |
| Where it runs | Higgsfield's cloud, their account | Your machine, inside your ComfyUI |
| Billing | Higgsfield credits | Your Comfy credits via Router; estimate shown before every run |
| Model | Not disclosed | You choose; model and provider printed on every result |
| Presets | Curated by Higgsfield | Scrolls anyone can make, share and fork |
| Prompt | Preset-driven | Exactly what you typed, plus visible helpers |
| Output | A video | A video with its recipe embedded inside |
| Source | Closed | MIT, with every ComfyUI workflow in the repo |

What we do best, in one line each: **transparency** (the recipe is the product), **portability** (the scroll format moves between people, the app and the ComfyUI graph), and **chaining** (edit a frame or a character, then perform it with Motion).

## Feature 1 — Motion Studio

Motion Studio turns a driving video plus reference images into a new clip that keeps the performance, camera and timing. The default engine is MiniMax H3 reference-to-video through Router; Genjutsu's own motion-transfer model and local open-weight engines are one dropdown away (full matrix in the models section).

**Inputs**

- **Driving video** — drag in or pick; a trimmer with in/out handles clamps it to the engine's window (H3 reference video: 2–15 s at 23.976–60 fps; Genjutsu: 4–30 s). ffmpeg transcodes to H.264 MP4 and caps size so the base64 body stays under Router's 100 MiB request limit (about 75 MB of raw media).
- **References** — up to 9 images for H3, 1–8 for Genjutsu. Each gets a role chip: Character, Outfit, Location, Style, Product. Roles compile into visible prompt sentences such as "Image 1 is the character; Video 1 is the motion", because H3's guide says explicit jobs per reference work much better.
- **Prompt** — free text, never rewritten. A helper row inserts the role sentences and reference tokens; the user can delete them.
- **Output** — duration 4–15 s, resolution 768P or 2K, aspect ratio, seed, audio on/off (H3 generates native stereo audio).

**Modes.** *Recast* (the core): keep motion, replace cast, location or look. *Swap* (stretch goal): change one element and keep the rest, using H3's video-as-edit-source role or a video-edit model.

**Run flow**

1. Preflight: validate the body against the model's Router schema, check durations and frame rate, and call `/estimate` to show the cost (or "cost unknown" when Router cannot price it).
2. Submit through queued delivery (`POST /v2/models/{provider}/{model}/requests`) with the scroll ID as the `Idempotency-Key`, so a dropped connection never double-charges.
3. Poll and show an indeterminate progress state; Router sends no live progress, so the UI shows elapsed time and the provider name instead of a fake percentage.
4. Download the result immediately into ComfyUI's output folder, because Router result URLs expire within 12–24 hours.
5. Write the scroll (inputs, body, result, seed, reported cost) and open the result view.

**Result view.** A synced A/B player (side by side or wipe) of source vs result, frame scrub, outcome buttons (Worked / Partly / Didn't) with a one-line note, and three next steps: Re-run with new seed, Try another engine with the same inputs, Fork into a new scroll.

## Feature 2 — Edit Studio

Edit Studio edits one to ten images from a written instruction, with FLUX 3 (`bfl/flux-3-image`) as the default engine, and boxes drawn on the canvas become FLUX 3's own bounding-box instructions.

**Inputs**

- **Canvas** — the base image, with a region tool. Each box gets a short label ("replace jacket with a yellow raincoat"). FLUX 3 has no separate box field: boxes ride at the end of the prompt as a JSON array of `{id, from, src_bbox, tgt_bbox, desc}` rows for edits. We append that JSON in a visible, collapsible block under the prompt.
- **Reference tray** — up to 10 images (FLUX 3's limit), each at least 256×256 px, at most 16 MP and 20 MB base64. Same role chips as Motion.
- **Params** — aspect ratio (auto follows the first image), resolution class (768sq, 1k, 1.5k, 2k, 4k), web grounding on/off, safety tolerance 0–4, seed, variant count.

**Variants.** Run 1–4 variants in parallel (throttled to stay under Router's per-caller concurrency limit), compare in a grid, star the keeper. Each variant is its own scroll, grouped under one parent.

**Two chains that make the demo:**

1. *Edit the cast, then perform it.* Edit a character or product image, then press **Send to Motion**: it lands in Motion's reference tray with its role chip, and the lineage is recorded in both scrolls.
2. *Restyle the first frame.* In Motion Studio, press **Edit this frame** on the driving video: the frame opens in Edit Studio, the user restyles it, and it returns as the Style/Location reference — so the restyle follows the original performance.

## Feature 3 — Scroll catalogue

The catalogue is a local library where every run is saved as a scroll automatically — references, prompt, model, params, result and the user's verdict — and any scroll is one click from a remix.

**Shelves**

- **Mine** — everything run on this machine, newest first.
- **Imported** — scrolls dropped in from files, links or output videos.
- **Starter** — 10–12 SFW scrolls shipped in the repo (our own footage, consenting performers) so the app is never empty on first run.
- **Community index** — optional: paste the URL of any public `index.json` (for example a GitHub repo of scrolls). We host nothing; the app just reads the file.

**Scroll card.** Poster with hover-scrub (source → result), mode badge (Motion / Edit), model chip, outcome mark (Worked / Partly / Didn't), reference count, date. Filters: mode, model, outcome, tag, source, has driving video. Full-text search over prompts, tags and notes.

**Scroll detail.** The result; every input with its role; the exact prompt; model, provider, params, seed and reported cost; the lineage (forked from, sent from Edit); the user's notes on what worked. Actions:

| Action | What it does |
| --- | --- |
| Remix | Loads every input and setting into the studio, ready to change |
| Re-run | Same body, new seed |
| Swap engine | Same inputs on another model — the core experiment loop |
| Use my video | Keeps the recipe, asks for a new driving video (for Light scrolls) |
| Export | Opens the share sheet (Full, Light or Recipe-only) |
| Open in ComfyUI | Loads the scroll's workflow into the ComfyUI canvas |

**Storage.** One folder per scroll under ComfyUI's user directory (`user/default/openillusion/scrolls/<id>/`), results in `output/openillusion/`, and a SQLite index with FTS5 for search. Deleting a scroll moves it to a local trash for 7 days.

## Feature 4 — Scroll bundles (the unique point)

A scroll is a portable, versioned bundle of one run's recipe and media that opens in OpenIllusion, in any ComfyUI through our Load Scroll node, and even from the output video itself — so sharing needs no server of ours.

**Three sizes**

| Variant | Contains | Typical size | Best for |
| --- | --- | --- | --- |
| Full | Manifest, full references, driving video, result preview, ComfyUI workflow | 10–80 MB | Exact reproduction, archiving |
| Light | Manifest, references downsized to 768 px, poster and 480p preview, no driving video | 1–5 MB | Discord, X, email; "bring your own video" remixes |
| Recipe-only | `scroll.json` alone, references as hashes and thumbnails | under 64 KB | Links, Gists, embedding inside outputs |

**File layout** (`*.scroll` is a zip with a fixed structure):

```
my-run.scroll
├── scroll.json          manifest (required)
├── refs/ref-01.webp     reference images, in slot order
├── driving/driving.mp4  optional; stripped in Light
├── result/preview.mp4   ≤ 720p, ≤ 8 MB
├── result/poster.webp
├── comfy/workflow.json  ComfyUI graph that reproduces the run
└── LICENSES.md          generated from per-asset license fields
```

**Manifest (v1, abridged)**

```json
{
  "format": "openillusion.scroll",
  "version": 1,
  "id": "01JB8Z…",
  "title": "Hallway take → rainy rooftop",
  "mode": "motion",
  "engine": { "kind": "router", "model": "minimax/minimax-h3", "provider": "comfy", "schema_version": "c0e2e941ffff" },
  "inputs": [
    { "slot": "video:1", "role": "motion", "file": "driving/driving.mp4", "sha256": "…", "license": "own-footage", "contains_person": true, "consent": true },
    { "slot": "image:1", "role": "character", "file": "refs/ref-01.webp", "sha256": "…", "license": "generated" }
  ],
  "prompt": "Image 1 is the character. Video 1 is the motion. Night rooftop, rain, neon reflections.",
  "params": { "duration": 8, "resolution": "768P", "ratio": "9:16", "seed": 418877 },
  "request_template": { "content": ["{{prompt}}", "{{image:1}}", "{{video:1}}"], "duration": "{{duration}}" },
  "result": { "file": "result/preview.mp4", "seed": 418877, "cost_reported": null },
  "outcome": "worked",
  "notes": "Explicit role sentences fixed identity drift.",
  "lineage": { "forked_from": null, "chain": ["edit:01JB8Y…"] },
  "attest": { "sfw": true, "rights": true }
}
```

**Recipe inside the output.** On save, the Recipe-only manifest is written into the result file: a PNG text chunk for images (the same mechanism ComfyUI uses to embed workflows) and a metadata tag on the MP4 via ffmpeg. Drop any OpenIllusion output onto the app or onto ComfyUI and the recipe re-opens; missing media becomes empty slots with a "use your own" prompt. This is the viral loop: the thing people share already carries how it was made.

**Sharing paths, none hosted by us**

- The `.scroll` file itself, anywhere files go.
- A link carrying a Recipe-only scroll in the URL fragment (`#scroll=<base64url>`), which browsers never send to a server.
- A GitHub Gist or repo; the community index is just an `index.json` listing scroll URLs, shared by pull request.

**ComfyUI node pack** (`ComfyUI-OpenIllusion`, published to the Comfy Registry):

- **Load Scroll** — input: a scroll file; outputs: IMAGE per reference, VIDEO, prompt STRING, model and params. Any ComfyUI user can drop a community scroll into their own graph.
- **Save Scroll** — takes images, video, prompt and the output from any workflow and writes a scroll. Recipes flow both ways between the app and the canvas.

**Import safety**

- Zip limits: 300 MB total, 200 entries, no absolute paths or `..` segments, whitelisted types only (JSON, PNG, JPEG, WebP, MP4, WebM, MD).
- The manifest is validated against a published JSON Schema; unknown fields are kept but ignored, so newer scrolls still open.
- Nothing executes on import. `workflow.json` is displayed, and any custom nodes it needs are listed, never auto-installed.
- File hashes are checked; EXIF and GPS are stripped on export.
- Export requires the SFW and rights attestation, and a consent tick for any input flagged as containing a real person.

## Architecture and tech stack

OpenIllusion is one ComfyUI custom node pack: it serves the web app from ComfyUI's own server, calls Comfy Router with the user's key for partner models, and uses ComfyUI's executor for local workflows — so there is nothing to deploy and nothing for us to host.

&#91;embedded content: OpenIllusion architecture · one local process, one cloud API\]

The browser talks only to OpenIllusion's routes inside ComfyUI; the routes call Router, queue local workflows, and read and write scrolls on disk. The only thing that ever leaves the machine besides model calls is a scroll the user chooses to share.

| Layer | Choice | Why |
| --- | --- | --- |
| Packaging | ComfyUI custom node pack `ComfyUI-OpenIllusion`: registers aiohttp routes on ComfyUI's `PromptServer`, serves the built app at `/openillusion`, adds a sidebar button in the ComfyUI frontend | One install through ComfyUI Manager or `comfy node install`; literally built on ComfyUI |
| Frontend | Vite, React, TypeScript, Tailwind CSS, Radix UI primitives, Zustand, TanStack Query | Fast to build; accessible primitives |
| Schema forms | Params rendered from each model's Router JSON schema (react-jsonschema-form or a small custom renderer) | Any Router model gets a form for free |
| Backend | Python in the ComfyUI process: aiohttp, httpx (async), pydantic, jsonschema | No second server |
| Router client | `comfy-sdk`: queued delivery, `Idempotency-Key` per scroll, `/estimate` preflight, catalog and schemas cached with ETag | Official SDK; recoverable, no double charges |
| Local engine | ComfyUI's `/prompt` queue and WebSocket progress with API-format workflow templates | Real progress bars for local runs |
| Media | ffmpeg via imageio-ffmpeg (trim, transcode, posters, MP4 metadata); Pillow (PNG text chunks, EXIF stripping) | Cross-platform and pip-installable |
| Storage | SQLite with FTS5 plus one folder per scroll | Searchable, serverless |
| Bundles | zip + `scroll.json`, validated by a published `schema/scroll.v1.json` | Anyone can write a reader |
| Secrets | Comfy API key stored in ComfyUI's user settings; never returned to the browser, never written into a scroll | BYOK without leaks |
| Quality | pytest for manifest, import and Router adapters; one Playwright smoke test each for Motion, Edit and Share | Safe changes in the last 48 hours |
| License | MIT, with THIRD\_PARTY.md | Rule compliance |

**Repo layout**

```
ComfyUI-OpenIllusion/
├── __init__.py          registers routes, nodes and the web directory
├── openillusion/            router client, run engine, store, bundles
├── nodes/               Load Scroll, Save Scroll
├── ui/                  React source  →  built into web/
├── workflows/           UI + API JSON for every engine
├── schema/scroll.v1.json
├── starter-scrolls/
└── LICENSE · README.md · THIRD_PARTY.md
```

## Models and ComfyUI workflows

Ship two curated defaults — MiniMax H3 for Motion and FLUX 3 for Edit — plus a short list of alternates, and expose every other Router model through an "Any model" picker filtered by each schema's declared input and output media.

| Feature | Engine | Route | Key limits | Status |
| --- | --- | --- | --- | --- |
| Motion (default) | MiniMax H3 reference-to-video | Router `minimax/minimax-h3` | Output 4–15 s, 768P or 2K; reference videos 2–15 s (15 s total), 23.976–60 fps; media as URL or data URI | Spike day 1: the schema has a `reference_video` role but its modality tag lists text and image only |
| Motion (fallback) | MiniMax H3 partner node | ComfyUI `MinimaxHailuo03ReferenceNode`, same Comfy key | Up to 9 images, 3 videos, 3 audio clips | Documented; use if the Router route refuses video |
| Motion (alt) | Higgsfield Genjutsu Motion Transfer | Router `higgsfield/higgsfield-genjutsu-motion-transfer-v1.0` | Source 4–30 s; 1–8 reference images; 480p–1080p; URLs only | Verified schema; needs public URLs for user media |
| Motion (local) | MiniMax H3 open weights | ComfyUI native `MiniMaxH3ReferenceToVideo` | Same as H3; needs a large GPU | Stretch: same scroll runs local or cloud |
| Motion (local) | Wan Animate 2 | ComfyUI template `video_wan_animate2` | One character image plus a driving video | Stretch |
| Swap (stretch) | Video edit models | `wan/wan2.7-videoedit`, `bfl/video-edit-v1`, `runway/aleph2`, `kling/kling-v3-omni` | Not checked yet | Read schemas before committing |
| Edit (default) | FLUX 3 | Router `bfl/flux-3-image` | 1–10 images, each 256 px–16 MP and ≤ 20 MB base64; 768sq to 4k; boxes as prompt JSON | Verified schema |
| Edit (alts) | Qwen-Image 3.0, Nano Banana 2, GPT Image 2.5, Seedream 5, Kling Image O1 | `qwen/qwen-image-3.0`, `google/nano-banana-2`, `openai/gpt-image-2.5-sunburst`, `byteplus/seedream-5-0-260128`, `kling/kling-image-o1` | Per schema | Auto-form from schema |
| Edit utilities | Relight, erase, replace background | `bria/image-edit-relight`, `bria/image-edit-erase`, `bria/image-edit-replace-background` | Per schema | Nice to have |
| Edit (local) | FLUX 3 Image Klein | ComfyUI native workflow | Open weights | Stretch |
| Finish | Video upscale | `wavespeed/seedvr2` or `fal/crystal-video-upscaler` | Per schema | Optional post step |

**Workflow files in the repo.** For each engine we commit a ComfyUI UI-format workflow under `workflows/` (H3 R2V, Genjutsu-via-partner-node if it exists, FLUX 3 edit, Wan Animate 2), plus the API-format twin the app submits for local runs. The scroll's `comfy/workflow.json` is generated from these templates with the run's values filled in, so "Open in ComfyUI" always reproduces the run on the canvas.

**Bonus eligibility.** H3 as Motion's default and FLUX 3 as Edit's default make each the core model of its workflow; the demo should show both defaults, not the alternates.

## Design handoff

Design OpenIllusion as a calm, dark, media-first pro tool with one ritual flourish: the red seal stamped on a scroll when it is exported. The chrome recedes; the footage is the hero; the recipe is always one glance away.

### Visual direction — "ink and washi"

| Token | Dark (default) | Light | Use |
| --- | --- | --- | --- |
| `bg` | #0E0D0C ink | #F6F1E8 washi | App background |
| `surface` | #171513 | #FFFDF8 | Panels, cards |
| `raised` | #23201D | #EFE8DC | Inputs, hovered cards |
| `line` | #34302B | #DDD3C3 | Borders, dividers |
| `text` | #F4EFE6 | #1A1714 | Primary text |
| `text-muted` | #A39A8C | #6B6257 | Secondary text, captions |
| `seal` | #E2462C vermilion | #C9381F | Run button, export seal, focus ring |
| `indigo` | #7C93DB | #3A55A8 | Links, selection, region boxes |
| `worked` | #8DB36B moss | #4E7A2E | Outcome: Worked |
| `partly` | #D9A441 ochre | #9A6B12 | Outcome: Partly |
| `didnt` | #B9675A | #8E3B2F | Outcome: Didn't |

- **Type:** Instrument Serif for display (screen titles, scroll titles), Inter for UI at 13–14 px, JetBrains Mono for prompts-as-sent and JSON. All from Google Fonts.
- **Grid and shape:** 8 px spacing, 8 px corner radius on cards, 6 px on inputs, 1 px borders, no drop shadows (elevation by surface tone).
- **Motif:** the scroll as a horizontal filmstrip; a small square vermilion seal (hanko-style mark with an "M") on exported scrolls; thin brush-stroke rule under section titles. Use sparingly.
- **Motion:** 150–200 ms ease-out; a scroll card "unrolls" (height reveal) into detail; the seal stamps (scale 1.2 → 1, 120 ms) on export. Respect reduced-motion.
- **Voice:** short and honest. "Ran on minimax-h3 via Comfy · 3m 12s". "Cost not reported." "This model doesn't report progress — here's the elapsed time."

### App shell

Left rail (64 px, icons + labels on hover): Library, Motion, Edit, Queue, Settings. Top bar: search, key status dot (green = Router reachable), local ComfyUI status, and an Import button. A bottom run tray (collapsed to 40 px) shows active jobs and expands into the Queue drawer.

### Screens

| # | Screen | Layout | Must show |
| --- | --- | --- | --- |
| 1 | Connect (first run) | Centered card on the ink background | Paste Comfy API key, Test (reads the Router catalog), local ComfyUI found or not, "Skip — browse starter scrolls" |
| 2 | Library | Shelf tabs (Mine, Imported, Starter, Community), filter bar, responsive card grid | Scroll cards with hover-scrub, mode badge, model chip, outcome mark; full-window drop overlay "Drop a .scroll, a OpenIllusion video or a link" |
| 3 | Motion Studio | Three columns: inputs (320 px) · stage (fluid) · engine panel (320 px); session filmstrip at the bottom | Driving-video card with trimmer, reference tray with role chips, prompt with helper chips, A/B player, engine dropdown, schema-driven params, cost estimate, vermilion Run, Raw JSON toggle |
| 4 | Edit Studio | Same three columns; the stage is a canvas with a region tool | Numbered boxes with labels, box JSON preview under the prompt, variant grid, Send to Motion |
| 5 | Scroll detail | Hero result, recipe card on the right, inputs strip and lineage below | Exact prompt in mono, model and provider, params, seed, reported cost, notes, action bar: Remix (primary), Re-run, Swap engine, Export, Open in ComfyUI |
| 6 | Share sheet | Modal, 560 px | Full / Light / Recipe-only with size estimates; toggles for strip driving video and embed recipe in output; license per asset; SFW, rights and consent ticks; Save file, Copy link, Copy JSON; seal stamp on success |
| 7 | Import review | Modal | Preview, validation list (passes, warnings such as unknown model or missing custom node), source, Add to library or Remix now |
| 8 | Queue drawer | Right drawer, 400 px | Jobs with states: Estimating, Queued, Running (elapsed), Downloading, Done, Failed, Moderated; cancel where possible |
| 9 | Settings | Two-column form | API key, default engines, output folder, max parallel runs, community index URLs, privacy (strip EXIF, web grounding default) |

### Components to design

Scroll card · reference slot with role chip (Character, Outfit, Location, Style, Product, Motion) · driving-video trimmer with in/out handles and duration readout · A/B player (side-by-side and wipe, synced scrub) · engine dropdown with model and provider chips · schema-driven param field set (enum → segmented control, int range → slider plus number, bool → switch, string → textarea) · cost estimate pill (exact / estimated / unknown) · region box with numbered label · outcome toggle (icon + word, never colour alone) · job row · validation row · the seal mark.

### States

- **Running:** indeterminate shimmer on the stage plus an elapsed timer and provider name; never a fake percentage.
- **Errors map to fixes:** request too large → offer trim or downscale; invalid input → highlight the field; rate limited → "waiting for a slot" with auto-retry; moderated → plain message, no retry button.
- **Empty:** Library shows the Starter shelf; Motion shows a full-stage drop zone for the driving video.
- **Keyboard:** Space play/pause, J/K/L scrub, R run, E export, ⌘K search.
- **Responsive:** desktop-first from 1280 px; under 1024 px the engine panel becomes a drawer; on phones only Library, Scroll detail and the share sheet are offered (view and share, not create).

### Paste-ready brief for Claude Design

```markdown
Design a desktop web app called OpenIllusion — an open-source Motion + Edit studio that runs inside ComfyUI.
Users bring their own Comfy API key; every run is saved as a "scroll" (a shareable bundle of references, prompt, model and settings).

Aesthetic: "ink and washi". Dark default: bg #0E0D0C, surface #171513, raised #23201D, line #34302B, text #F4EFE6, muted #A39A8C.
One accent: vermilion #E2462C for the Run button, focus rings and a small square seal mark stamped on exported scrolls.
Indigo #7C93DB for selection and region boxes. Outcome colours: moss #8DB36B, ochre #D9A441, clay #B9675A (always with icon + word).
Type: Instrument Serif (display), Inter 13–14px (UI), JetBrains Mono (prompts and JSON). 8px grid, 8px radius, 1px borders, no shadows.
Media is the hero; chrome recedes. Voice: short, honest, shows model + provider + elapsed time on every result.

Screens: (1) Connect key, (2) Library with shelves Mine/Imported/Starter/Community and hover-scrub scroll cards,
(3) Motion Studio — inputs column (driving video trimmer, reference tray with role chips, prompt), stage (A/B synced player), engine column (model picker, schema-driven params, cost estimate, Run, Raw JSON),
(4) Edit Studio — same layout, canvas with numbered region boxes, variant grid, "Send to Motion",
(5) Scroll detail with recipe card and actions Remix / Re-run / Swap engine / Export / Open in ComfyUI,
(6) Share sheet with Full / Light / Recipe-only, attestation ticks and the seal stamp,
(7) Import review, (8) Queue drawer with job states, (9) Settings.
Show running states as elapsed time (no fake progress). Start with Motion Studio at 1440×900, then Library, then the Share sheet.
```

## Roadmap

Seven days: spikes today, the engine tomorrow, features through Tuesday, then polish, starter scrolls and the demo — with the form submitted Thursday evening, half a day before the 9am PT close.

&#91;embedded content: Build roadmap · Oct 23–30, 2026\]

Each day ends on something that runs; if a day slips, cut from the bottom of the list below rather than squeezing the demo.

**Exit criteria**

1. **Fri 23** — one H3 motion run and one FLUX 3 edit succeed from a script through `comfy-sdk`; Motion's default engine decided; repo public with LICENSE; signed up.
2. **Sat 24** — the node pack loads in ComfyUI, `/openillusion` serves the app, and a run started from the UI saves a scroll to disk.
3. **Sun 25** — Motion Studio end to end: trimmer, role chips, queued run, A/B player.
4. **Mon 26** — Edit Studio with region boxes and Send to Motion; Library with Remix and Swap engine.
5. **Tue 27** — export and import of Full, Light and Recipe-only; recipe embedded in PNG and MP4; Load and Save Scroll nodes work in a graph.
6. **Wed 28** — feature freeze at night; local engine only if everything else is green; get feedback at the SF Build Night.
7. **Thu 29** — 10–12 starter scrolls, README, clean-machine test, demo recorded, form submitted.
8. **Fri 30** — buffer only.

**Cut order if behind:** local engines → Swap mode → community index → MP4 embedding (keep PNG plus a sidecar file) → parallel variants → Edit utilities. **Never cut:** Router motion, FLUX 3 edit, scroll export and import, the Load Scroll node, the demo video.

## Demo video and submission

A three-minute demo that opens on the viral loop, proves both features on the sponsor defaults, and spends 20 seconds saying why it is innovative — the Most Innovative prize requires that explanation.

| Time | Beat | On screen |
| --- | --- | --- |
| 0:00–0:10 | Hook | Drag a OpenIllusion output video onto the app; it unrolls into its full recipe. "This video knows how it was made." |
| 0:10–0:25 | Why | Preset apps hide the recipe behind credits. OpenIllusion runs in your ComfyUI with your key and shows everything. |
| 0:25–1:05 | Motion | Our own hallway take plus one character reference → MiniMax H3 via Router → A/B wipe; model, provider, elapsed time and cost on screen |
| 1:05–1:35 | Edit | FLUX 3 edit with two region boxes on a frame → Send to Motion → second run |
| 1:35–2:05 | Catalogue | Library, outcome marks, notes; Swap engine on the same inputs to compare models |
| 2:05–2:30 | Share | Export a Light scroll (seal stamp); import it on a second machine; Load Scroll node inside a ComfyUI graph |
| 2:30–2:50 | Innovation | Recipe embedded in outputs; one format readable by the app and by ComfyUI; schema-driven, so any Router model works; nothing hosted |
| 2:50–3:00 | Credits | Every tool and model used, MIT license, repo link |

**Submission checklist**

- [ ] Public repo with MIT LICENSE, README (install, key, first run, troubleshooting) and THIRD\_PARTY.md
- [ ] `workflows/` with UI and API JSON for every engine
- [ ] 10–12 starter scrolls, all SFW, our own footage, signed consent from anyone on camera
- [ ] Demo video uploaded, naming every external tool and model and explaining the innovation
- [ ] Fresh-machine test on Windows and macOS: clone to first result in under 10 minutes
- [ ] Node pack published to the Comfy Registry
- [ ] Submission form sent by Thursday evening PT, a buffer before the Friday 9am PT close
- [ ] Launch post with the demo clip and a downloadable starter scroll, tagged #OpenSourceHiggsfield

## Risks, open questions and sources

The biggest risk is the motion default: confirm on day one that MiniMax H3 on Router accepts a reference video, because everything else in the plan has a documented path.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| H3 on Router refuses `reference_video` | Motion default breaks | Day-1 spike; fall back to the H3 partner node in ComfyUI (same Comfy key) or the Genjutsu route |
| URL-only inputs (Genjutsu takes `video_url`, `image_urls`) | Local files can't be sent | Default to models that take data URIs or base64; for URL-only models, upload via Comfy Cloud assets (API access needs a paid Cloud plan) or accept a user-supplied URL |
| Router access: docs say it is not generally available yet; queued delivery needs a workspace key | Runs fail | Test the key on day one; fall back to the synchronous route (10-minute server deadline) |
| Unpriced runs: many models return no pre-flight estimate | Surprise spend | Show "cost unknown", require a confirm click, cap parallel runs in Settings |
| Result URLs expire (12–24 h) | Lost outputs | Download on completion, before writing the scroll |
| IP, likeness and SFW rules | Disqualification | Own footage, signed consent, no celebrity or franchise references, attestation on export |
| Malicious scroll files | Security hole | Import rules in the bundle section: limits, whitelist, schema validation, no execution |
| Higgsfield's own model inside an "open source Higgsfield" entry reads oddly | Weaker story | Keep it an alternate, never a default; the demo's hero runs on H3 and FLUX 3 |
| Seven days | Unfinished build | Cut list in the roadmap; feature-freeze Wednesday night |

**Open questions**

- Can one entry win a main prize and a bonus? The page lists that question in its Q&A, but the answer didn't load when fetched — ask in the Comfy Discord.
- Do Comfy Cloud asset URLs work as public inputs for Router providers?
- Solo or team? Rules allow one submission per person; agree who submits.

**Sources** (as of Oct 23, 2026)

- [Open Source Higgsfield — competition page](https://comfy.org/open-source-higgsfield/)
- [ComfyUI Wiki — challenge write-up](https://comfyui-wiki.com/en/news/2026-10-15-open-source-higgsfield)
- [Higgsfield Genjutsu — product page](https://higgsfield.ai/genjutsu) and [Product Hunt listing](https://www.producthunt.com/posts/1005829)
- [Introducing Comfy Router](https://blog.comfy.org/p/introducing-comfy-router-one-api) and [Router product page](https://comfy.org/platform/router/)
- [Router capabilities and limits](https://docs.comfy.org/development/comfy-router/limitations) and [headers](https://docs.comfy.org/development/comfy-router/headers)
- [Router serving providers](https://docs.comfy.org/development/comfy-router/providers) and [model index (llms.txt)](https://docs.comfy.org/llms.txt)
- Schemas: [Genjutsu motion transfer](https://docs.comfy.org/router-schemas/higgsfield/higgsfield-genjutsu-motion-transfer-v1.0.json), [MiniMax H3](https://docs.comfy.org/router-schemas/minimax/minimax-h3.json), [FLUX 3 image](https://docs.comfy.org/router-schemas/bfl/flux-3-image.json), [LTX 2.5 Pro](https://docs.comfy.org/router-schemas/ltx/ltx-2-5-pro.json)
- [MiniMax H3 on Comfy](https://comfy.org/minimax-h3/), [H3 workflow guide](https://docs.comfy.org/tutorials/partner-nodes/minimax/minimax-h3/workflow), [H3 reference node](https://docs.comfy.org/built-in-nodes/MinimaxHailuo03ReferenceNode.md)
- [Wan Animate 2 on Comfy](https://comfy.org/wan-animate-2/), [LTX 2.5 on Comfy](https://comfy.org/ltx-2.5/)
- [Comfy SDKs](https://docs.comfy.org/development/api-development/sdks)
