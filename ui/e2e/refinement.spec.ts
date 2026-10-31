import { test, expect, type Page } from "@playwright/test";

const base = {
  mode: "edit", provider: "Example", blurb: "Make something new", max_images: 0, min_images: 0,
  needs_video: false, video_window: null, fps_window: [1, 60], url_only: false, params: [],
  curated: true, source: null, inputs: [], fields: [], origin: "shipped", varies: true,
  defaults: { prompt: "A mountain at sunrise", inputs: [] },
};
const templates = [
  { ...base, id: "local/qwen21-create", label: "Create a photo", kind: "local", model_name: "Qwen" },
  { ...base, id: "local/qwen21-add-hat", label: "Add a hat", kind: "local", model_name: "Qwen" },
  { ...base, id: "cloud/text-to-image", label: "Create a cloud photo", kind: "cloud", model_name: "Cloud model" },
];
const status = {
  version: "test", has_key: true, onboarded: true, router: { ok: true, reason: null },
  local: { ok: true, comfyui: true, v2: true, comfyui_url: "http://127.0.0.1:8188", gpu: "Test GPU", proxy_installed: true, autostart: true },
};
const checks = {
  reachable: true,
  templates: {
    "local/qwen21-create": { ok: true, missing_nodes: [], missing_models: [], bad_values: [] },
    "local/qwen21-add-hat": { ok: false, missing_nodes: [{ class_type: "MissingNode", node_ids: ["1"] }], missing_models: [], bad_values: [] },
  },
};

const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });

async function mockApp(page: Page, initial = status) {
  let current = structuredClone(initial);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status") return route.fulfill({ json: current });
    if (path === "/api/engines") return route.fulfill({ json: templates });
    if (path === "/api/local/readiness") return route.fulfill({ json: checks });
    if (path === "/api/local/check") return route.fulfill({ json: { reachable: true, ...checks.templates["local/qwen21-create"] } });
    if (path === "/api/compose") return route.fulfill({ json: { template: {}, warnings: [] } });
    if (path === "/api/onboarded") { current.onboarded = true; return route.fulfill({ json: { ok: true } }); }
    if (path === "/api/key/test") { current = { ...current, has_key: true, router: { ok: true, reason: null } }; return route.fulfill({ json: current.router }); }
    if (path === "/api/generations" || path === "/api/jobs") return route.fulfill({ json: [] });
    // No browser test may start a job or change the real server's settings.
    if (route.request().method() !== "GET") return route.abort();
    return route.continue();
  });
}

test("onboarding gives cloud users a direct path without ComfyUI", async ({ page }) => {
  await mockApp(page, { ...status, onboarded: false, has_key: false, router: { ok: false, reason: null }, local: { ...status.local, ok: false, comfyui: false, v2: false } });
  await page.goto("/#/connect");
  await expect(page.getByRole("heading", { name: "Where would you like to create?" })).toBeVisible();
  await page.getByRole("button", { name: /Use cloud/ }).click();
  await expect(page.getByText("No ComfyUI found yet.")).toHaveCount(0);
  await page.getByLabel("Comfy API key", { exact: true }).fill("comfyui-test-not-a-real-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Explore cloud templates" }).click();
  await expect(page).toHaveURL(/source=cloud/);
  await expect(page.locator(".tcard")).toHaveCount(1);
  await expect(page.locator(".tcard")).toContainText("Create a cloud photo");
});

test("local onboarding and browsing stay available without a connection", async ({ page }) => {
  await mockApp(page, { ...status, onboarded: false, local: { ...status.local, comfyui: false } });
  await page.goto("/#/connect");
  await page.getByRole("button", { name: /Use my GPU/ }).click();
  await expect(page.getByLabel("ComfyUI address")).toBeVisible();
  await expect(page.getByRole("button", { name: "Explore local templates" })).toBeDisabled();
  await page.getByRole("button", { name: "Look around first" }).click();
  await expect(page.locator(".tcard")).toHaveCount(3);
});

test("a rejected cloud key stays editable and cannot complete setup", async ({ page }) => {
  await mockApp(page, { ...status, onboarded: false, has_key: false, router: { ok: false, reason: null } });
  await page.route("**/api/key/test", route => route.fulfill({ json: { ok: false, reason: "unauthorized", message: "Key rejected" } }));
  await page.goto("/#/connect");
  await page.getByRole("button", { name: /Use cloud/ }).click();
  await page.getByLabel("Comfy API key", { exact: true }).fill("invalid-test-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#welcome-key-result")).toContainText("Key rejected");
  await expect(page.getByRole("button", { name: "Explore cloud templates" })).toBeDisabled();
  await expect(page.getByLabel("Comfy API key", { exact: true })).toHaveValue("invalid-test-key");
});

test("failed setup completion stays on the page with a retryable error", async ({ page }) => {
  await mockApp(page, { ...status, onboarded: false });
  await page.route("**/api/onboarded", route => route.fulfill({ status: 500, json: { error: "Storage unavailable" } }));
  await page.goto("/#/connect");
  await page.getByRole("button", { name: "Look around first" }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't finish setup");
  await expect(page).toHaveURL(/connect/);
});

test("ready filter verifies requirements and combines with Local and Cloud", async ({ page }) => {
  await mockApp(page);
  await page.goto("/#/explore");
  await expect(page.locator(".tcard")).toHaveCount(3);
  await page.getByRole("button", { name: /Ready to run/ }).click();
  await expect(page.locator(".tcard")).toHaveCount(2);
  await page.getByRole("button", { name: "Runs on", exact: true }).click();
  await page.getByRole("button", { name: /^Local Your ComfyUI/ }).click();
  await expect(page.locator(".tcard")).toHaveCount(1);
  await expect(page.locator(".tcard")).toContainText("Create a photo");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".tcard")).toHaveCount(3);
  await expect(page.locator(".tcard .pill.mine")).toHaveCount(0);
});

test("an unavailable readiness check never labels local templates ready", async ({ page }) => {
  await mockApp(page);
  await page.route("**/api/local/readiness", route => route.fulfill({ json: { reachable: false, templates: {} } }));
  await page.goto("/#/explore");
  await page.getByRole("button", { name: /Ready to run/ }).click();
  await expect(page.locator(".tcard")).toHaveCount(1);
  await expect(page.locator(".tcard")).toContainText("Create a cloud photo");
});

test("an upstream mismatch excludes local templates even when their models exist", async ({ page }) => {
  await mockApp(page, { ...status, local: { ...status.local, upstream_match: false } } as typeof status);
  await page.goto("/#/explore");
  await page.getByRole("button", { name: /Ready to run/ }).click();
  await expect(page.locator(".tcard")).toHaveCount(1);
  await expect(page.locator(".tcard")).toContainText("Create a cloud photo");
});

test("cloud runs explain unavailable cost and count each variant", async ({ page }) => {
  await mockApp(page);
  await page.goto("/#/explore");
  await page.getByRole("button", { name: "Open Create a cloud photo in Create" }).click();
  await expect(page.locator(".rb-cost")).toContainText("Cost unavailable · 1 paid run");
  await page.getByRole("group", { name: "Variants, one seed each" }).getByRole("button", { name: "4", exact: true }).click();
  await expect(page.locator(".rb-cost")).toContainText("4 paid runs");
});

test("details and keyboard navigation retain their focus behavior", async ({ page }, info) => {
  await mockApp(page);
  await page.goto("/#/explore");
  await page.getByRole("button", { name: "Details for Create a photo", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Template details" });
  await expect.poll(() => inspector.evaluate(el => el.contains(document.activeElement))).toBe(true);
  if (info.project.name === "phone") {
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      await expect.poll(() => inspector.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
  }
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  await expect(page.locator(".inspector")).toHaveAttribute("inert", "");
  await page.keyboard.press("3");
  await expect(page).toHaveURL(/library/);
});

test("reduced motion and phone layout preserve usable controls", async ({ page }) => {
  await mockApp(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/explore");
  await expect(page.locator(".tcard")).toHaveCount(3);
  expect(await page.locator(".tcard").first().evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.locator(".wall>.tile").evaluateAll(tiles => tiles.every(tile => {
    const wall = tile.parentElement!.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    return box.left >= wall.left - 1 && box.right <= wall.right + 1;
  }))).toBe(true);
  await page.getByRole("button", { name: "Runs on", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Runs on filter" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Runs on", exact: true })).toBeFocused();
});
