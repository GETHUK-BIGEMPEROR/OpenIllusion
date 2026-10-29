# The app

What each screen does and the rules the design keeps. How it's built is in
[ARCHITECTURE.md](../ARCHITECTURE.md).

## The app, screen by screen

Hash routes keep the app one static page (`lib/route.ts`). The rail on the left
holds Explore, Create, Library, Build, Queue, and at the bottom Trash and Settings. On phones it is a tab bar
(Explore, Library, Create, Queue, More); More opens Build, Trash and Settings;
keys 1–4 jump between the first four, Ctrl K opens the palette.

Every page header ends with two status chips (`KeyStat`, `GpuStat` in
`components/oi.tsx`), each opening a card on click:

| Chip | Says | Card |
| --- | --- | --- |
| **Comfy API** | Connected · No key · Key refused · Can't reach · Checking | The key's last four characters and where it's from, what it's for (Comfy Router, usage in the Comfy dashboard, files by link), Check again, Settings. |
| **GPU** (e.g. RTX 4060 Ti · ComfyUI 0.42) | Ready, or a progress ring while a local run goes; hidden when no ComfyUI answers | GPU memory, the run in flight, the queue, ComfyUI and Comfy API v2 addresses. |

| Screen | Route | What you do there | File |
| --- | --- | --- | --- |
| Explore | `#/explore` | Every published template on one wall: photos and videos, your GPU and cloud together. Drafts (saved in Build, not published yet) are not on Explore: they wait in the Queue. On top, one search field (`/` jumps to it, Esc clears; it reads the name, model, blurb and prompts, best matches first) with how many match. Under it the filters: Photo / Video, Model (each says Your GPU or Cloud; that is where it runs), Input (a photo, a clip, a sound, words only), Clear, and Sort on the right (Recently used, the default, then Featured, Newest (by when a template joined the app: `added` in the template file, for a shipped one the day it shipped, for yours when you made, copied or added it; stripped on export; an older file of yours without it falls back to the file's time), Most used, A to Z; used = runs you started, kept in `usage.json` so deleting a result doesn't forget them). Each card's caption says what it is sorted by, after the model: when it last ran, how many runs, or when it joined (Not run yet when it never ran); ties keep featured order. The wall puts each card in its shortest column, so a sorted wall reads in order, top to bottom; every card sits in one parent, placed by position, so a filter or sort slides cards instead of rebuilding them (`components/Masonry.tsx`). The neon edge (a masked layer) exists only on the card hovered or picked. Every cover loop on screen plays and pauses once scrolled away (`settle` in `components/oi.tsx`); none with reduced motion. Nothing over the wall is blurred (pills, the sticky header, the Add a template bar): a blur over a playing loop is redrawn every frame. Each filter's counts follow the others. There are no tags: search and the filters find templates. Cards on the wall have no before/after wipe: while the wall scrolls under a resting mouse, hover set it off on every card passing by (a full-size photo decoded each time); the details panel still shows the cover against its input. Under a card's name is its model: a Router template's comes from its model (Wan 3.0, Seedance 2.5), whatever you name it; a workflow's is the model its author named in Build or the inspector (`model_name`). Under the model, an orange tag says where it comes from: **Default** (ships with OpenIllusion) or **Created by you** (built or imported here); Create's header and the inspector say the same. Click a card to run it in Create; (i) opens the inspector on the right, where name, blurb, prompt and cover (and a workflow's model) are edited in place. Its trash button deletes a template you built or copied, or takes a shipped one off Explore (its file stays; Settings → Templates puts it back); the card's hover buttons end with the same trash (right of (i)), and Create's header has it too, with Export .illusion. A bar stuck to the bottom of the wall (see-through, at most 720 px wide), **Add a template someone shared**, takes a template's `.illusion` (drop or Choose file; dropping one anywhere does the same): it lands on Explore as yours, opened in the inspector. A template without a cover yet shows its name until a result is made its cover. The inspector shows the cover beside its input as a slider you drag across, photos or clips (two clips loop in step). | `screens/Explore.tsx`, `components/TemplateInspector.tsx` |
| Create | `#/create` (photo), `#/motion` (video) | One studio for both: pick a template, fill its inputs (a list of file cards, each with whether the model takes it), edit the one you pick right on the stage, edit the prompt (on cloud templates, chips put each filled file's name, Image 1 or Video 1, at the cursor), pick the result's settings (shape tiles, size steps with the pixels they make, length, resolution, sound), Run. The stage has two tabs, Inputs and Result, and the header always names the template. Opening a template shows Result as after Run: your latest run of it, else the template's example (the cover beside the input it was made from, marked Example on the frame and in the bar); Inputs flips to editing. Every result, photo or clip, sits over one bar: what it is on the left (Example, Your run or Earlier run, with when, size and seed), Side by side or Wipe on the right (side by side until you pick the wipe; the pick is kept, run to run and on a run's page: `abView` in `lib/store.ts`), and for clips play and the timeline. The result is set against its lead input (Wipe, Side by side) only when it's made over that input: the photo edited, a first frame, the clip edited; a template whose files are references (photos or a clip guiding a new video) shows the result alone, and its card has no before. A run's frame has a download button at its top right: the photo or clip itself, named after the run (Export makes a `.illusion` instead). A finished run's buttons, always in this order: All N (variants), Re-run (only when the workflow re-rolls its seed), Export, Use as cover (any finished run of this template, a draft's too; primary while it has no cover, quiet once it has one; a draft's cover stays with it when published), Open in Library. Picking an older run in the Runs column (or the strip at medium widths) puts **Use these inputs** in the bar: its files, prompt and settings go back on the left (`loadGeneration`). There is no Remix in Create; Open in Create on the Library and Generation pages does the same from there. A draft shows a bar under the cover first: Draft, Not on Explore yet, whether it has been tested, and **Publish** (off until a run of it has finished; with no cover set, Publish makes the run on stage, else the latest, its cover). Under the cover, one row: Build from this (every template; a cloud one opens on its model with its inputs, prompt and settings), Export .illusion, the ComfyUI workflow (local ones, an icon) and delete. Each input card has one line under its name: the file's size, then whether the model takes it or the size it runs at. The run bar says where it runs and, for a local template whose nodes and models are all there, Models found (what's missing is listed under the template). The 1–4 variants control is always there; a fixed-seed workflow shows it locked at 1. | `screens/create/`, `components/Studio.tsx`, `MediaEditor.tsx`, `Trimmer.tsx` |
| Library | `#/library` | Every run, newest first, grouped by day. Shelves: My generations, Imported, Community. Tabs: All, Starred, Active, Failed. On phones (no rail) a link at the bottom leads to Trash. | `screens/Library.tsx` |
| Trash | `#/trash` | Deleted generations grouped by the day they were deleted, each with days left of its 7. Restore or delete for good one at a time, or Select several; Restore all, Empty trash. | `screens/Trash.tsx` |
| Generation | `#/generation/{id}` | One result full screen: the result against its input in Create's player, side by side or the wipe as last picked (a photo run can also show Input or Result alone), variants, re-run, Open in Create, notes, download (the result file itself), export and share. Arrows step through the Library. | `screens/GenerationDetail.tsx`, `ShareSheet.tsx` |
| Build | `#/build`, `#/build?from={template}`, `#/build?track=cloud` (opens on Comfy Router) | Make a template in three steps; see [Builder](TEMPLATES.md#making-a-template-builder). | `screens/builder/` |
| Queue | drawer | Every run from both studios, grouped by what it needs from you: Running, Up next, Needs attention, then **Drafts** (templates saved in Build and not published: a Draft pill, orange until a run of it finishes, then mint Ready; click one to open it in Create, run it and publish it; its trash deletes it, held to confirm), then Finished (a finished run's check turns into a remove button under the pointer: off the queue, still in the Library; Clear finished takes them all). | `screens/QueueDrawer.tsx` |
| Settings | `#/settings` | Your GPU (ComfyUI and proxy URLs), Output limits, Templates (shipped ones taken off Explore, each with Put back), Storage (disk use, clean working copies, back up and restore, the output folder: typed, or **Choose…** for the folder picker), Cloud (API key). | `screens/Settings.tsx` |
| Connect | `#/connect` | First run only: check the ComfyUI on this machine, then open Explore. No account. | `screens/Connect.tsx` |
| Export template | Create's header, the inspector | **Export .illusion**: one template with its samples and the cover you set, to share, as it is: no export date, no Builder state, no use history, files without their own dates (see [What leaves without dates](../ARCHITECTURE.md#what-leaves-without-dates)). The other OpenIllusion drops it on Explore's Add a template (or anywhere) and it's theirs: deletable, under a new id if theirs is taken. Local templates also keep **ComfyUI workflow**, a `.json` for ComfyUI itself (dropped back here it starts a new template in Build). | `server/template_pack.py`, `components/TemplateCard.tsx` |
| Export | sheet | Export on a finished run (Create, the Generation page): a `.illusion` file (Light, Full, or Recipe only), the recipe as JSON, or a link. It says what the file is for: drop it on any OpenIllusion page or press Library → Import; it opens under Imported, and Open in Create loads it to run again. | `screens/ShareSheet.tsx` |
| Import | dialog | Library → Import, a drop anywhere, or a link: a bundle, PNG or MP4 with a recipe. Review, then add to the Library. A dropped ComfyUI workflow goes to Build instead. | `screens/ImportReview.tsx` |
| Edit a file | Create's stage; a sheet in the Builder | One workbench for every photo, clip and sound: the model's limits as pills on top (green fits, orange a run changes it, red can't run; a pill opens its tool) with **Fit to spec**, tools on the left (crop, turn, size, cut, rate, sound), the file in the middle with what the model keeps outlined, the tool's settings on the right, a clip's timeline below (past the model's length is hatched: not sent), and what changes along the bottom. Hold for original. In Create the edits wait on the input and are made when it runs (crop and cut go through the run's own crop and trim; turn, size, rate and sound make a new file just before the run, or now with Apply now). In the Builder, Save makes the new file. The original always stays. On a local template the size tool is **Size it runs at**: the template's steps (0.5 MP, 1 MP…, each with the pixels it makes at the crop's shape) or Custom, which opens width and height; picking a step drops a typed size. Every "Runs at" sizes the file as its edits will make it (`runInput`). | `components/MediaEditor.tsx`, `lib/edits.ts` |
| Restore | dialog | A dropped `.illusionbackup` (or Settings → Storage → Choose file): what it would add, then Restore, with progress. | `screens/RestoreReview.tsx` |

## Design rules

The current design is the settled one. Change it on purpose, and write the change
here in the same commit.

- **Higgsfield-simple.** Each screen has one main action (Use, Run, Save), in
  the neon gradient. The box's own settings (sampler, steps, model flags) never show.
- **Say what it is, not how it's built.** Inputs read Image 1, Video 1, Audio 1;
  modes read Text to video, Image to video, Video edit. Node ids, field paths and
  model ids appear only as small mono text.
- **Show only what can be used.** A Router model's modes are a row of tabs, and a
  mode shows only its inputs, so you never fill two that can't go together. A
  model with one mode shows no tabs.
- **Status is always in sight.** Whether cloud and local can run is a chip in
  every header, in one or two words; details are a click away, never a page away.
- **Every gate says why.** Run is never greyed out without the reason next to it
  ("Video edit needs a Video to edit", "Give the template a name").
- **Steps you can walk back.** The Builder's steps show where you are; Back sits at
  the top, and a finished step is clickable. Leaving asks first
  only when something of yours would be lost (a name, a dropped file).
- **One editor per file, everywhere.** A photo, clip or sound is the same card
  and opens the same editor wherever it sits (Create's input list, the Builder's
  samples); each card says in one line whether the model takes it, and the editor
  shows the model's limits as pills, never a separate tool.
- **Undo over confirm.** Deleting moves to Trash and the toast offers Undo; a
  confirm dialog is for losing work that can't come back.
- **Live, never polled by you.** Job progress arrives over the WebSocket into the
  Queue drawer and the Library card.
- **A run says what it's doing.** `components/RunStatus.tsx` draws every live run
  (Create's stage, the Library card, the detail page): a stage track (Getting
  ready, In line, Sampling or Generating, Saving), what it's on in words, time
  spent and time left. A local run shows its sampler step, node and the sampler's
  own preview frames (ComfyUI sends them when started with `--preview-method auto`),
  and its time left comes from its pace. Comfy Router sends no progress, so a cloud
  run shows an indeterminate bar and counts against `typical`: the median time of
  the template's last finished runs (`store.typical`, set on the job at start;
  none until two have finished).
- **No page titles.** The rail already names the section, so a page never repeats
  it; each keeps a hidden `<h1>` for screen readers. The top row is filters,
  actions, search and the status chips.
- **Look ("Afterglow").** Compact and near-black (`--bg #07060D`) with faint
  pink, violet and cyan glows. The accent is one neon gradient, `--neon`
  (pink `#FF4FA3` → violet `#9D6BFF` → cyan `#2FD8FF`), for the main action, the
  current rail item, focus rings and progress; icon strokes take it through the
  shared SVG gradient `#ng` in the sprite. `--accent` is the pink alone where a
  flat colour is needed; `--mint` done, `--violet` cloud, `--orange` warning,
  `--rose` error. Buttons are 32px, the rail 64px, cards 10px apart. Unbounded for headings, Sora for text, Geist Mono for numbers and
  ids. All styling is plain CSS in `ui/src/styles/` (no utility framework):
  tokens and the reset in `base.css`, shared pieces (buttons, pills, fields,
  notices) in `common.css` and `fields.css`, one stylesheet per area beside them
  (`builder.css`, `studio.css`, `library.css`…), with phone layouts in
  `responsive.css`.
