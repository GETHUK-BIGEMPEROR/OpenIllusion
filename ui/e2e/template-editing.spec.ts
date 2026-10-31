import { test, expect, type Page } from "@playwright/test";

const source = {
  id: "cloud/my-template", mode: "edit", kind: "cloud", origin: "user", built: true, draft: false,
  label: "My photo template", provider: "Example", model_name: "Example model", model: "example/model",
  blurb: "An existing template", max_images: 0, min_images: 0, needs_video: false,
  inputs: [], fields: [{ key: "prompt", type: "text", label: "Prompt", required: true, default: "Original saved prompt" }], params: [],
  defaults: { prompt: "Original saved prompt", inputs: [] }, varies: true,
};
const adapter = {
  model: "example/model", name: "Example model", mode: "edit", inputs: [], mentions: {},
  settings: [{ key: "quality", type: "select", label: "Quality", options: ["standard", "high"], default: "standard", off_with: [], only_with: [] }],
};

async function editingApp(page: Page, own = true, failSave = false) {
  let template = { ...source, origin: own ? "user" : "shipped" };
  const saves: Record<string, unknown>[] = [];
  const runs: unknown[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/status") return route.fulfill({ json: { version: "test", onboarded: true, has_key: true, router: { ok: true }, local: { ok: false, comfyui: false, v2: false } } });
    if (path === "/api/engines") return route.fulfill({ json: [template] });
    if (path === "/api/builder/models") return route.fulfill({ json: [adapter] });
    if (path === "/api/builder/from-template") {
      const edit = request.postDataJSON().edit;
      return route.fulfill({ json: { kind: "cloud", base: template.id, model: adapter.model, label: edit ? template.label : `${template.label} (copy)`, blurb: template.blurb, mode: "edit", media: [], prompt: { default: template.defaults.prompt }, settings: { quality: { value: "high", locked: true } } } });
    }
    if (path === "/api/builder/save") {
      const spec = request.postDataJSON();
      saves.push(spec);
      if (failSave) return route.fulfill({ status: 409, json: { error: "Wait for this template's active runs to finish" } });
      template = { ...template, id: spec.replace || "cloud/saved-copy", label: spec.label, blurb: spec.blurb, origin: "user", draft: !spec.replace,
        defaults: { prompt: spec.prompt?.default || "", inputs: [] } };
      return route.fulfill({ json: template });
    }
    if (path === "/api/compose") return route.fulfill({ json: { template: {}, warnings: [] } });
    if (path === "/api/run") { runs.push(request.postDataJSON()); return route.fulfill({ json: { ids: ["test-run"] } }); }
    if (path === "/api/generations" || path === "/api/jobs") return route.fulfill({ json: [] });
    if (request.method() !== "GET") return route.abort();
    return route.continue();
  });
  return { saves, runs, errors };
}

test("Create offers editing independently from Build from this", async ({ page }) => {
  const state = await editingApp(page);
  await page.goto("/#/explore");
  await page.getByRole("button", { name: "Open My photo template in Create" }).click();
  await expect(page.getByRole("button", { name: "Build from this", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit template", exact: true }).click();
  await expect(page).toHaveURL(/build\?edit=/);
  await expect(page.getByLabel("Template name")).toHaveValue(source.label);
  await expect(page.getByLabel("The prompt the template opens with")).toHaveValue("Original saved prompt");
  await expect(page.getByRole("button", { name: "Save template", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("template-editor.png") });
  expect(state.errors).toEqual([]);
});

test("Save template updates the same template without starting a run", async ({ page }) => {
  const state = await editingApp(page);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await page.getByLabel("Template name").fill("My revised template");
  await page.getByLabel("Description", { exact: true }).fill("Updated description");
  await page.getByLabel("The prompt the template opens with").fill("New saved prompt");
  await page.getByRole("group", { name: "Quality on Create" }).getByRole("button", { name: "Ask on Create" }).click();
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page).toHaveURL(/#\/create$/);
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]).toMatchObject({ replace: source.id, label: "My revised template", blurb: "Updated description", prompt: { default: "New saved prompt" }, settings: [{ key: "quality", value: "high", locked: false }] });
  expect(state.runs).toHaveLength(0);
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("New saved prompt");
  expect(state.errors).toEqual([]);
});

test("Save as copy never sends a replace target", async ({ page }) => {
  const state = await editingApp(page);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await page.getByRole("button", { name: "Save as copy", exact: true }).click();
  await expect(page).toHaveURL(/#\/create$/);
  expect(state.saves[0].replace).toBeUndefined();
  expect(state.saves[0].label).toBe("My photo template (copy)");
  expect(state.runs).toHaveLength(0);
});

test("shipped templates offer both saving an override and making a copy", async ({ page }) => {
  const state = await editingApp(page, false);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await expect(page.getByRole("button", { name: "Save template", exact: true })).toBeVisible();
  await expect(page.getByLabel("Template name", { exact: true })).toHaveValue(source.label);
  await page.getByRole("button", { name: "Save as copy", exact: true }).click();
  await expect(page).toHaveURL(/#\/create$/);
  expect(state.saves[0].replace).toBeUndefined();
  expect(state.runs).toHaveLength(0);
});

test("Save template updates a shipped template under the same id without a run", async ({ page }) => {
  const state = await editingApp(page, false);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await page.getByLabel("Description", { exact: true }).fill("My local override");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page).toHaveURL(/#\/create$/);
  expect(state.saves[0]).toMatchObject({ replace: source.id, label: source.label, blurb: "My local override" });
  expect(state.runs).toHaveLength(0);
});

test("saving does not require a test prompt", async ({ page }) => {
  const state = await editingApp(page);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await page.getByLabel("The prompt the template opens with").fill("");
  await page.getByText("Test this template", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Save and test", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page).toHaveURL(/#\/create$/);
  expect(state.runs).toHaveLength(0);
});

test("Save and test is an explicit opt-in to one run", async ({ page }) => {
  const state = await editingApp(page);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await page.getByText("Test this template", { exact: true }).click();
  await page.getByRole("button", { name: "Save and test", exact: true }).click();
  await expect.poll(() => state.runs.length).toBe(1);
  expect(state.saves[0].replace).toBe(source.id);
  expect(state.errors).toEqual([]);
});

test("failed saves keep the edit form and its changes", async ({ page }) => {
  const state = await editingApp(page, true, true);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await page.getByLabel("Description", { exact: true }).fill("Keep these changes");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("active runs");
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Keep these changes");
  expect(state.runs).toHaveLength(0);
});

test("leaving unsaved edits can be cancelled or explicitly discarded", async ({ page }) => {
  const state = await editingApp(page);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await page.getByLabel("Description", { exact: true }).fill("Unsaved work");
  await page.getByRole("button", { name: "Back to Create", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard template edits?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Unsaved work");
  await expect(page).toHaveURL(/build\?edit=/);
  await page.getByRole("button", { name: "Back to Create", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(/#\/create$/);
  expect(state.saves).toHaveLength(0);
  expect(state.runs).toHaveLength(0);
});

test("Build from this remains a new-template flow", async ({ page }) => {
  const state = await editingApp(page);
  await page.goto("/#/build?from=cloud%2Fmy-template");
  await expect(page.getByLabel("Template name")).toHaveValue("My photo template (copy)");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page).toHaveURL(/#\/create$/);
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0].replace).toBeUndefined();
  expect(state.runs).toHaveLength(0);
});

test("the save panel is reachable and testing is optional in both layouts", async ({ page }, info) => {
  await editingApp(page);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  const save = page.getByRole("button", { name: "Save template", exact: true });
  await expect(save).toBeInViewport();
  await expect(page.locator(".brail-test")).not.toHaveAttribute("open", "");
  if (info.project.name === "phone") await expect(page.locator(".brail-preview")).not.toHaveAttribute("open", "");
  else await expect(page.locator(".brail-preview")).toHaveAttribute("open", "");
  if (info.project.name === "phone") {
    const saveBox = await save.boundingBox();
    const nameBox = await page.getByLabel("Template name", { exact: true }).boundingBox();
    expect(saveBox!.y).toBeLessThan(nameBox!.y);
  }
  await page.getByText("Test this template", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Save and test", exact: true })).toBeVisible();
});

test("new cloud templates can be saved without a paid test run", async ({ page }) => {
  const state = await editingApp(page);
  await page.goto("/#/build?track=cloud");
  await page.getByRole("button", { name: /^Example model:/ }).click();
  await page.getByLabel("Template name", { exact: true }).fill("My new template");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page).toHaveURL(/#\/create$/);
  expect(state.saves[0]).toMatchObject({ label: "My new template" });
  expect(state.saves[0].replace).toBeUndefined();
  expect(state.runs).toHaveLength(0);
});

test("cloud model search has useful empty-state recovery", async ({ page }) => {
  await editingApp(page);
  await page.goto("/#/build?track=cloud");
  const search = page.getByRole("searchbox", { name: "Find a cloud model" });
  await search.fill("nothing-matches-this");
  await expect(page.getByRole("button", { name: /^Example model:/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Example model:/ })).toBeVisible();
  await expect(search).toHaveValue("");
  await page.screenshot({ path: test.info().outputPath("builder-cloud-start.png") });
});

test("source choices expose their selected state and work with the keyboard", async ({ page }) => {
  await editingApp(page);
  await page.goto("/#/build");
  const sources = page.getByRole("group", { name: "Build from", exact: true });
  const cloud = sources.getByRole("button", { name: /Comfy Router/ });
  const local = sources.getByRole("button", { name: /Local workflow/ });
  await expect(local).toHaveAttribute("aria-pressed", "true");
  await cloud.focus();
  await page.keyboard.press("Enter");
  await expect(cloud).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("searchbox", { name: "Find a cloud model" })).toBeVisible();
  await local.focus();
  await page.keyboard.press("Space");
  await expect(local).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Drop a ComfyUI workflow/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("builder-local-start.png") });
});

test("Builder keeps edits and contained panels when the layout changes", async ({ page }) => {
  await editingApp(page);
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await page.getByLabel("Description", { exact: true }).fill("Keep this across layouts");
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Keep this across layouts");
    await expect.poll(() => page.locator(".bld-main").evaluate(main => {
      const bounds = main.getBoundingClientRect();
      return [...main.querySelectorAll(".bidentity,.bsec,.bsave,.brail-fold")].every(panel => {
        const rect = panel.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      });
    })).toBe(true);
  }
});

test("cancelling edits preserves the unsent Create draft", async ({ page }) => {
  const state = await editingApp(page);
  await page.goto("/#/explore");
  await page.getByRole("button", { name: "Open My photo template in Create" }).click();
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("My unsent draft");
  await page.getByRole("button", { name: "Edit template", exact: true }).click();
  await expect(page.getByLabel("The prompt the template opens with")).toHaveValue("Original saved prompt");
  await page.getByLabel("Description", { exact: true }).fill("Discard this change");
  await page.getByRole("button", { name: "Back to Create", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("My unsent draft");
  expect(state.saves).toHaveLength(0);
});

test("prefill failure is retryable and never opens a blank new-template form", async ({ page }) => {
  await editingApp(page);
  let attempts = 0;
  await page.route("**/api/builder/from-template", async route => {
    if (++attempts === 1) return route.fulfill({ status: 503, json: { error: "ComfyUI is offline" } });
    return route.fallback();
  });
  await page.goto("/#/build?edit=cloud%2Fmy-template");
  await expect(page.getByText("Couldn't open the template", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save template", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save template", exact: true })).toBeVisible();
});

test("local editing preserves prefilled values and saves Ask/Lock changes in place", async ({ page }) => {
  const state = await editingApp(page);
  let localTemplate = { ...source, id: "local/my-template", kind: "local", model_name: "My GPU workflow" };
  const saves: Record<string, unknown>[] = [];
  await page.route("**/api/engines*", route => route.fulfill({ json: [localTemplate] }));
  await page.route("**/api/builder/from-template", route => route.fulfill({ json: {
    token: "local-draft", source: "my-template.json", format: "api", nodes: 3, notes: [], mode: "edit",
    media: [], texts: [{ node: "1", input: "text", title: "Prompt", value: "Original saved prompt", polarity: "positive" }],
    prompt: { node: "1", input: "text" }, params: [{ node: "2", input: "steps", title: "Sampler", type: "int", value: 8, min: 1, max: 30, step: 1, suggested: true }],
    outputs: ["3"], results: [{ node: "3", title: "Save image", kind: "image" }], sizes: [], size: null,
    canvas: { aspects: ["1:1"], steps: { edit: ["1 MP"], motion: ["1 MP"] } },
    check: { ok: true, missing_nodes: [], missing_models: [], bad_values: [] },
    preset: { base: localTemplate.id, label: source.label, blurb: source.blurb, mode: "edit", model_name: localTemplate.model_name,
      media: [], prompt: { node: "1", input: "text", label: "Prompt", default: "Original saved prompt", required: true },
      params: [{ node: "2", input: "steps", key: "steps", type: "int", label: "Steps", default: 12 }], size: null, outputs: ["3"] },
  } }));
  await page.route("**/api/builder/save", route => {
    const spec = route.request().postDataJSON();
    saves.push(spec);
    localTemplate = { ...localTemplate, label: spec.label };
    return route.fulfill({ json: localTemplate });
  });
  await page.route("**/api/local/check", route => route.fulfill({ json: { ok: true, reachable: true, missing_nodes: [], missing_models: [], bad_values: [] } }));
  await page.goto("/#/build?edit=local%2Fmy-template");
  await page.getByRole("group", { name: "Steps on Create" }).getByRole("button", { name: "Lock", exact: true }).click();
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page).toHaveURL(/#\/create$/);
  expect(saves[0]).toMatchObject({ replace: localTemplate.id, kind: "local", params: [], fixed: [{ node: "2", input: "steps", value: 12 }] });
  expect(state.runs).toHaveLength(0);
  expect(state.errors).toEqual([]);
});
