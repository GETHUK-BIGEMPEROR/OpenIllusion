# OpenIllusion

A template studio for ComfyUI, made as simple as Higgsfield: pick a template, drop
in your images, videos or sounds, edit the prompt, press Run, get a result.

- **Local** runs a ComfyUI workflow on your own GPU through Comfy API v2.
- **Cloud** runs premium models that make video or photos on
  [Comfy Router](https://docs.comfy.org/development/comfy-router/reference.md),
  billed to your Comfy API key. A file a model only takes as a link is first
  uploaded to Comfy Cloud's asset store with the same key.

Open source under the [MIT license](LICENSE). Entered in Comfy's
[Open Source Higgsfield](https://comfy.org/open-source-higgsfield/) contest; see
[Contest entry](#contest-entry). To run it, see [Setup](#setup).

**Docs.** This page is what the app is and how to run it. The rest:

| Doc | What's in it |
| --- | --- |
| [docs/APP.md](docs/APP.md) | Every screen and what it does; the design rules |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System and code map, one run end to end, storage and backups, the API, status and weak spots |
| [docs/TEMPLATES.md](docs/TEMPLATES.md) | The template file, the Builder, Comfy Router models and their adapters, adding a model |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running it for development, tests, conventions |

## Contest entry

| | |
| --- | --- |
| Contest | [Open Source Higgsfield](https://comfy.org/open-source-higgsfield/) by Comfy, build period 10/15 to 10/30/2026 |
| What it is | A working app on top of ComfyUI that lets anyone run, and make, their own Higgsfield-style templates: pick one, drop in photos, clips or sounds, press Run |
| License | MIT ([LICENSE](LICENSE)) |
| Setup | [Setup](#setup) below: install, the models each template needs, start |
| Model bonus | **Built with MiniMax H3** |
| Demo video | _link added at submission_ |

**MiniMax H3 is the core model.** Every video template that runs on your own GPU runs
MiniMax H3 through ComfyUI's built-in H3 nodes: Create a video (the full model, 20 steps),
Create a video Turbo and H3 T2V Turbo (from words) and Animate a photo (photo as first
frame), all video with sound on H3 FL2VA, the last three with its turbo LoRA; and
Character swap (H3 Ref2VA with a character swap LoRA). The
local photo templates (Qwen Image 2.1) make and fix the stills those videos start from.
The cloud templates (Comfy Router, your key) are there beside them for people with no GPU.

**What's new in it:**

- **Templates as black boxes.** Any ComfyUI workflow becomes a template with only
  numbered inputs, one prompt and the output settings any generator has (shape, size,
  length); the app detects them and runs the workflow untouched. A new template is a
  draft until a run of it works; Publish then puts it on Explore with that result as
  its cover. See [The idea](#the-idea).
- **Files fitted to the model.** Each input card says whether the model takes the file
  as it is; one editor crops, cuts, resizes and resamples to fit before the run. See the
  Edit a file row in [The app](docs/APP.md#the-app-screen-by-screen).
- **Recipes travel with results.** Every result keeps its inputs, workflow and settings;
  export, import, Open in Create and whole-library backups carry them.

Built with ComfyUI, comfy-api-proxy (Comfy API v2), MiniMax H3 and Qwen Image 2.1 by
Comfy-Org, the [MiniMax H3 Character Swap LoRA](https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA)
by akatz-ai.

## Setup

Windows, macOS or Linux. The app is a small Python server with a web page; ComfyUI does
the GPU work. Install it with Python (1a) or run it in Docker (1b), then add the models
(2) and, for cloud templates, a key (3).

**You need**

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) recent enough to have the MiniMax
  H3 and Qwen Image 2.1 nodes (ComfyUI Desktop works too), running on `http://127.0.0.1:8188`.
  Another address can be set in Settings → Your GPU. Built and tested with ComfyUI 0.42 on
  an RTX 4060 Ti 16 GB. Only for local templates: cloud ones need no GPU.
- Disk for the models of the templates you want (below). A Comfy API key only for cloud templates.
- For 1a: Python 3.10 or newer, Node.js 18 or newer, git. For 1b: Docker with Compose.

**1a · Install with Python**

Windows (PowerShell):

```powershell
git clone https://github.com/GETHUK-BIGEMPEROR/OpenIllusion.git
cd OpenIllusion
py -m venv .venv
.venv\Scripts\python -m pip install -e .
npm --prefix ui install
npm --prefix ui run build
.venv\Scripts\python -m server --open
```

macOS and Linux:

```bash
git clone https://github.com/GETHUK-BIGEMPEROR/OpenIllusion.git
cd OpenIllusion
python3 -m venv .venv
.venv/bin/python -m pip install -e .
npm --prefix ui install
npm --prefix ui run build
.venv/bin/python -m server --open
```

The app opens at http://127.0.0.1:7870. On first start it checks the ComfyUI on this
machine, then opens Explore. It starts comfy-api-proxy (Comfy API v2) on `:8189` itself;
`pip install` brought it in. Next time, only the last line. Options: `--port 7871`,
`--host` (default `127.0.0.1`; anything else lets other machines spend your credits),
`--open` (open the browser).

**1b · Or run it in Docker**

```bash
git clone https://github.com/GETHUK-BIGEMPEROR/OpenIllusion.git
cd OpenIllusion
docker compose up --build -d
```

Open http://127.0.0.1:7870. The container holds the app only: ComfyUI and its models
stay where they are, and the app reaches the ComfyUI on your machine at
`host.docker.internal:8188` (set by `OPENILLUSION_COMFYUI_URL` in `docker-compose.yml`;
Settings → Your GPU changes it later). Your library lives in the `openillusion-home` volume,
not in the container, so `docker compose up --build -d` after a `git pull` keeps it.
The port is published on `127.0.0.1` only. If the app says ComfyUI isn't answering, ComfyUI
is listening on its own loopback only: start it with `--listen` (Linux needs this), and keep
port 8188 closed to your network in the firewall. Cloud-only use needs no ComfyUI at all.

**2 · Put the models in ComfyUI.** Each template lists what it's missing (with download
links) before it runs; the app never downloads models. Into ComfyUI's `models/` folders:

| File | Folder | Size | Used by |
| --- | --- | --- | --- |
| [minimax_h3_fl2va_pruned_int8_convrot](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors) | `diffusion_models` | 21 GB | Create a video, H3 T2V Turbo, Animate a photo |
| [minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors) | `loras` | 2 GB | Create a video, H3 T2V Turbo, Animate a photo |
| [minimax_h3_ref2va_pruned_int8_convrot](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) | `diffusion_models` | 21 GB | Character swap |
| [h3_character_swap_pro4500_1000](https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/main/h3_character_swap_pro4500_1000.safetensors) | `loras` | 0.2 GB | Character swap |
| [qwen3vl_32b_minimax_h3_int8_convrot](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors) | `text_encoders` | 27 GB | every H3 template |
| [minimax_h3_video_vae_int8_convrot](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors) | `vae` | 2.8 GB | every H3 template |
| [minimax_h3_audio_vae_fp32](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) | `vae` | 0.6 GB | every H3 template |
| [qwen_image_2.1_int8_convrot](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors) | `diffusion_models` | 7.3 GB | every photo template |
| [qwen3vl_8b_int8_convrot](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors) | `text_encoders` | 9.4 GB | every photo template |
| [qwen_image_2.1_vae_bf16](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors) | `vae` | 0.7 GB | every photo template |

Restart ComfyUI (or press Check again in the app) after adding files.

**3 · Cloud templates (optional).** Paste a Comfy API key in Settings → Cloud. The
browser keeps it; the server never saves it. A headless server can take it from `COMFY_API_KEY`.

**Update.** `git pull`, then `pip install -e .` and `npm --prefix ui run build` again (or,
with Docker, `docker compose up --build -d`). Your library is not in the repo and stays.

**Where your things are.** Everything you make (results, templates you build, settings,
uploads, the trash) is in one home folder: `~/.openillusion`, or the folder
`OPENILLUSION_HOME` names. Settings → Storage shows its size and makes a `.illusionbackup`.
Never the API key: that stays in the browser.

**If something's off**

| What you see | Do this |
| --- | --- |
| "another server is already using …" at start | One server per home folder. Use the running one, or start a second with its own `OPENILLUSION_HOME`. |
| Port 7870 is taken | `python -m server --port 7871` (Docker: change the left side of `127.0.0.1:7870:7870`). |
| "ComfyUI isn't answering" | Start ComfyUI, or set its address in Settings → Your GPU, then Check again. |
| "Comfy API v2 isn't running" | `pip install comfy-api-proxy` into the same `.venv`; its log is `proxy.log` in the home folder. |
| A template lists missing nodes or models | Install those into ComfyUI (Manager's Install Missing, or the links in the table above), restart ComfyUI, Check again. The app never installs anything. |
| Cloud Run says to add a key | Settings → Cloud. |
| A blank page after an update | `npm --prefix ui run build`, then reload. |

## The idea

Three rules hold everywhere, local and cloud, in the Builder and on Create.

**1 · A template is a black box.** Behind every template sits one thing the app
never edits: a ComfyUI workflow, or a Router model's request. Sampler, steps,
LoRAs and the seed mode stay as their author saved them. A random seed is
re-rolled each run; a fixed seed stays fixed.

**2 · Inputs, a prompt and the result's settings go in.** Inputs have no names: they
are Image 1, Image 2, Video 1, Audio 1, and the prompt says what each one is for.
There is one prompt, with no hidden text added; a cloud model gets "Image 1" in its
own form (see [Naming files in the prompt](docs/TEMPLATES.md#naming-files-in-the-prompt)). Then the
settings every generator has, where no input already decides them: the result's
shape and size, its length, resolution, sound (see [Settings](docs/TEMPLATES.md#settings-what-people-choose-about-the-result)).
Anything else is the box's business.

**3 · A template is frozen to its job.** A built template asks for exactly the
inputs its first run used, all required, so it does the same job every time. It
is saved as a **draft** (`"draft": true` in its file): Create has it, Explore doesn't.
Create's header says so, whether it has been tested (a finished run), and has
**Publish**, which takes a finished run (the one on the stage, else the latest), makes
it the cover when there is none, and puts the template on Explore. Untested templates
can't be published. Drafts wait in the Queue, under Drafts. Every
shipped template ships with its cover. A cover is shown beside the input it was made
from: setting one keeps a copy of that run's lead photo or clip (`covers/<id>.before.*`),
and a shipped cover pairs with the shipped samples. A photo cover is made from the full
result (up to 1600 px), not its 960 px poster, so it is as sharp as the input beside it.

The two kinds differ only in where the box comes from and who knows its inputs:

| | Local | Cloud |
| --- | --- | --- |
| The box | A ComfyUI workflow (API format) | A Router model id plus its native JSON request |
| Its inputs come from | **Detection**: loaders, text boxes and save nodes in the workflow | **An adapter**: a hand-written JSON file per model |
| Which ones | Any workflow that runs in ComfyUI | Only models with an adapter |
| What it can do | Whatever the workflow does | Every mode the model has: text-only, first frame, first + last frame, references, edit… The inputs you fill pick the mode. |
| Freeze | Built in: the workflow's loaders are fixed and each needs a file | At save: the template keeps the mode its run used |
| Runs through | `local.py` → comfy-api-proxy `:8189` → your ComfyUI | `router.py` → `api.comfy.org/v2/models/{provider}/{model}`; files by link via `cloud.comfy.org/api/v2/assets` |
| Cost | Free, on your GPU | Paid per run; usage is in your Comfy dashboard (OpenIllusion shows no prices) |
| Progress | Live: sampler step, node, preview frames, time left from the pace so far | Stage and queue position; time counted against how long this template usually takes (never a made-up percent) |
| When it fails | Missing nodes and models are listed, never installed; ComfyUI's errors pass through | Router's errors pass through |

Detection works for workflows because ComfyUI's node types are one shared
vocabulary. Router has none: in its own words, "each model accepts its own native
request body and returns its own native result". Guessing inputs from schemas
breeds endless bugs, so every cloud model gets an adapter, written by hand from
its Router docs.

## The templates it ships

Each one was run for real before it shipped. Local ones need the
models in [Setup](#setup); cloud ones need a Comfy API key.

| Template | Model | Runs | Takes | Makes |
| --- | --- | --- | --- | --- |
| Create a video | MiniMax H3 | Your GPU | words | video with sound, full model, 20 steps |
| Create a video Turbo | MiniMax H3 | Your GPU | words | video with sound, turbo LoRA, 6 steps |
| H3 T2V Turbo | MiniMax H3 | Your GPU | words | video with sound, 6 steps |
| Animate a photo | MiniMax H3 | Your GPU | a photo (first frame) | video with sound |
| Character swap | MiniMax H3 | Your GPU | a clip and a photo | the clip with the photo's character |
| Create a photo | Qwen Image 2.1 | Your GPU | words | photo |
| Add a hat, Add glasses, New hair, Makeup, Expression, Outfit swap, Holding a product | Qwen Image 2.1 | Your GPU | a photo (two for outfit and product) | the photo, edited |
| Background swap, Relight, Season & weather, Recolor, Remove anything, Restyle, Restore & colorize, Product shot, Remove background | Qwen Image 2.1 | Your GPU | a photo | the photo, edited |
| Text to Image | Seedream 5.0 Pro, GPT Image 2, Grok Imagine Image 2.0 | Cloud | words | photo |
| Text to Video | Veo 3.1 Fast, Kling 3 Omni, Wan 3.0 | Cloud | words | video with sound |
| Reference to Video | Wan 3.0 | Cloud | a photo | video with sound |
| Swap character | Kling 3 Omni | Cloud | a clip and a photo | the clip with the photo's character |
| Character Swap | Seedance 2.5 | Cloud | a clip and a photo | the clip with the photo's character in place of its own |
| Swap two people, Multi character swap | Seedance 2.5 | Cloud | a clip and two photos | the clip with both people swapped |
| Dancing Animal | Seedance 2.5 | Cloud | a clip and a photo | the clip with the photo's animal |

Make your own from any ComfyUI workflow or Router model in Build
([docs/TEMPLATES.md](docs/TEMPLATES.md#making-a-template-builder)).

## License

[MIT](LICENSE), © 2026 GETHUK-BIGEMPEROR. Models, LoRAs and node packs the templates use are not
part of this repo and keep their own licenses.
