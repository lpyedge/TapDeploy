// Entry-step E2E tests for the installer UI. Every backend call is
// stubbed at the network layer with page.route, so this exercises the real
// React UI. Only the pre-auth config entry-step tests that pass against the
// current UI are kept here; the V3 product UI flow is covered by
// tests/e2e/prebuilt-ui-flow.spec.ts.

import { expect, test, type Page, type Route } from "@playwright/test";

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

// The entry step only reads the session state; every other API call is a test
// failure surface, so nothing else is stubbed.
async function mockApi(page: Page, options: { session: Record<string, unknown> | null }): Promise<void> {
  const { session } = options;
  await page.route("**/api/auth/session", (route) =>
    session === null ? json(route, { authenticated: false }) : json(route, session),
  );
}

test.describe("dynamic installer UI", () => {
  test("pasted legacy config is refused before authorization", async ({ page }) => {
    await mockApi(page, { session: { authenticated: false } });
    const starts: string[] = [];
    page.on("request", (request) => { if (request.url().endsWith("/api/auth/start")) starts.push(request.url()); });
    await page.goto("/");
    await page.getByTestId("config-input").fill('{"schemaVersion":2}');
    await page.getByTestId("config-go").click();
    await expect(page.getByTestId("config-errors")).toContainText("only Config V3");
    expect(starts).toEqual([]);
  });

  test("quick link with an invalid config stays on the entry step with the address filled in", async ({ page }) => {
    await mockApi(page, { session: { authenticated: false } });
    const configUrl = "https://config.example.com/bad.json";
    await page.route(configUrl, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ schemaVersion: 2 }) }),
    );
    let starts = 0;
    await page.route("**/api/auth/start", (route) => { starts++; return json(route, {}, 500); });
    await page.goto(`/?config=${encodeURIComponent(configUrl)}`);
    await expect(page.getByTestId("config-errors")).toBeVisible();
    await expect(page.getByTestId("config-input")).toHaveValue(configUrl);
    expect(starts).toBe(0);
  });
  test("config URL: the size is decided by HEAD and an oversized file is never downloaded", async ({ page }) => {
    await mockApi(page, { session: { authenticated: false } });
    const configUrl = "https://config.example.com/huge.json";
    const methods: string[] = [];
    await page.route(configUrl, (route) => {
      methods.push(route.request().method());
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*", "content-length": String(5 * 1024 * 1024) }, body: "" });
    });
    await page.goto("/");
    await page.getByTestId("config-input").fill(configUrl);
    await page.getByTestId("config-go").click();
    await expect(page.getByTestId("config-errors")).toContainText("the limit is 64.0 KiB");
    expect(methods).toEqual(["HEAD"]);
  });
  test("pasted config shows its size and an oversized paste is refused before parsing", async ({ page }) => {
    await mockApi(page, { session: { authenticated: false } });
    await page.goto("/");
    await page.getByTestId("config-input").fill("x".repeat(70 * 1024));
    await expect(page.getByTestId("config-size")).toContainText("70.0 KiB of 64.0 KiB");
    await page.getByTestId("config-go").click();
    await expect(page.getByTestId("config-errors")).toContainText("the limit is 64.0 KiB");
  });
  test("dropping a local JSON file fills the textarea", async ({ page }) => {
    await mockApi(page, { session: { authenticated: false } });
    await page.goto("/");
    const text = JSON.stringify({ schemaVersion: 3, app: { id: "drop/test", name: "Drop" }, source: { allowLocalZip: true }, capabilities: ["workers"] });
    await page.getByTestId("config-input").evaluate((el, t) => {
      const dt = new DataTransfer();
      dt.items.add(new File([t], "tapdeploy.config.json", { type: "application/json" }));
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, text);
    await expect(page.getByTestId("config-input")).toHaveValue(text);
  });
  test("choosing a local JSON file fills the textarea, and the hints say how", async ({ page }) => {
    await mockApi(page, { session: { authenticated: false } });
    await page.goto("/");
    await expect(page.locator(".config-hints")).toContainText("Paste the link to a tapdeploy.config.json, or paste its content.");
    await expect(page.locator(".config-hints")).toContainText("or drop it onto the box above");
    const text = JSON.stringify({ schemaVersion: 3, app: { id: "pick/test", name: "Pick" }, source: { allowLocalZip: true }, capabilities: ["workers"] });
    await page.getByTestId("config-file").setInputFiles({ name: "tapdeploy.config.json", mimeType: "application/json", buffer: Buffer.from(text) });
    await expect(page.getByTestId("config-input")).toHaveValue(text);
  });
  test("help tooltips open on tap and close with Escape", async ({ page }) => {
    await mockApi(page, { session: { authenticated: false } });
    await page.goto("/");
    const tip = page.locator(".infotip").first();
    await expect(tip.locator(".infotip-pop")).toBeHidden();
    await tip.getByRole("button").click();
    await expect(tip.locator(".infotip-pop")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    await expect(tip.locator(".infotip-pop")).toBeHidden();
  });
  test("a denied necessary OAuth scope is an explicit non-destructive UI state", async ({ page }) => {
    // The operator declined a necessary scope during OAuth. The app must show a
    // clear, non-destructive notice, return the user to the config step (no
    // destructive write, no auto second OAuth), and never persist a token.
    await mockApi(page, { session: null });
    await page.goto("/?auth=error&error=scope_denied&success=0");
    await expect(page.getByTestId("config-step")).toBeVisible();

    // The notice says what happened, that nothing changed, and what to do.
    await expect(page.locator(".notice")).toContainText(/did not allow every permission/i);
    await expect(page.locator(".notice")).toContainText(/nothing was changed/i);
    await expect(page.locator(".notice")).toContainText(/scope_denied/);

    // No token ever reaches browser storage, even on a failed auth.
    const storages = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));
    expect(storages.local.toLowerCase()).not.toContain("tok-");
    expect(storages.session.toLowerCase()).not.toContain("tok-");

    // Non-destructive: the safe landing is the config step and there is never a
    // deploy/confirm button surfaced from a failed auth.
    await expect(page.getByTestId("confirm-deploy")).toHaveCount(0);
  });
});
