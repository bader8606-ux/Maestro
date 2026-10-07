import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

const firstLogo = {
  name: "sponsor-original.png",
  mimeType: "image/png",
  buffer: readFileSync("public/brand/maestro-logo.png"),
};
const replacementLogo = {
  name: "sponsor-replacement.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
    "base64",
  ),
};

// Choosing through a visible button and the browser's filechooser event catches
// disabled or non-interactive upload controls that direct input injection misses.
async function chooseFile(page, control, file, keyboard = false) {
  assert.equal(await control.isEnabled(), true);
  const chooser = page.waitForEvent("filechooser");
  if (keyboard) {
    await control.focus();
    await control.press("Enter");
  } else await control.click();
  await (await chooser).setFiles(file);
}

await test("Sponsor logo controls choose, save, replace and retry real uploads", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "maestro-logo-ui-"));
  const server = spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  const errors = [];
  try {
    const base = await new Promise((resolve, reject) => {
      let log = "";
      const timer = setTimeout(
        () => reject(new Error("Logo test server startup timed out.")),
        30000,
      );
      server.stdout.on("data", (data) => {
        log += data;
        const match = log.match(/listening on port (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve("http://127.0.0.1:" + match[1]);
        }
      });
      server.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Logo test server exited before startup."));
      });
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    const request = async (url, method = "GET", data) => {
      const response = await context.request.fetch(base + "/api" + url, {
        method,
        headers: { "X-Requested-With": "Maestro" },
        ...(data === undefined ? {} : { data }),
      });
      assert.equal(response.ok(), true, "Fixture API request failed: " + url);
      return response.json();
    };
    await request("/setup", "POST", {
      token: readFileSync(path.join(dir, "setup-token"), "utf8"),
      name: "Logo Test Administrator",
      email: "logo-admin@example.test",
      password: randomBytes(24).toString("hex"),
    });
    const viewerPassword = randomBytes(24).toString("hex");
    await request("/users", "POST", {
      name: "Logo Test Viewer",
      email: "logo-viewer@example.test",
      password: viewerPassword,
      role: "viewer",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    const mutations = [];
    page.on("request", (req) => {
      if (
        ["POST", "PUT", "DELETE"].includes(req.method()) &&
        /\/api\/(sponsors|attachments)(\/|$)/.test(req.url())
      )
        mutations.push({ url: req.url(), method: req.method() });
    });
    await page.goto(base);
    await page
      .getByRole("heading", { name: "Digital Government Forum", exact: true })
      .waitFor();
    let sponsorId, attachmentId, dialog;
    const selectedPreview = () =>
      dialog.locator('.sponsor-logo-display[data-logo-state="pending"] img');
    const currentLogo = () =>
      dialog.locator('.sponsor-logo-display[data-logo-state="saved"] img');
    const waitForLoadedImage = async (image) => {
      await image.waitFor();
      await image.evaluate((element) => {
        if (element.complete && element.naturalWidth > 0) return;
        return new Promise((resolve, reject) => {
          element.addEventListener("load", resolve, { once: true });
          element.addEventListener(
            "error",
            () => reject(new Error("Logo image did not load.")),
            { once: true },
          );
        });
      });
      assert.equal(
        await image.evaluate((element) => element.naturalWidth > 0),
        true,
      );
    };
    const waitForAllSponsorImages = async (width) => {
      const selector = ".sponsor-avatar img, .logo-picker img";
      await page.waitForFunction(
        ({ selector, width }) => {
          const images = Array.from(document.querySelectorAll(selector));
          return (
            images.length > 1 &&
            images.every(
              (image) => image.complete && image.naturalWidth === width,
            )
          );
        },
        { selector, width },
      );
      const widths = await page
        .locator(selector)
        .evaluateAll((images) => images.map((image) => image.naturalWidth));
      assert.equal(
        widths.every((actual) => actual === width),
        true,
      );
    };
    const openSponsor = async (name) => {
      const record = page.locator(".complete-record").filter({
        has: page.getByRole("heading", { name, exact: true }),
      });
      await record
        .getByRole("button", { name: "Edit Sponsor", exact: true })
        .click();
      dialog = page.getByRole("dialog").last();
      await dialog.getByLabel("Sponsor Name", { exact: true }).waitFor();
    };
    const saveLogo = async (buttonName, attachmentPath) => {
      const saved = page.waitForResponse(
        (response) =>
          response.url() === base + "/api" + attachmentPath &&
          response.request().method() === "POST",
      );
      await dialog
        .getByRole("button", { name: buttonName, exact: true })
        .click();
      const response = await saved;
      assert.equal(response.ok(), true);
      await waitForLoadedImage(currentLogo());
      assert.equal(await selectedPreview().count(), 0);
    };

    await t.test(
      "The new sponsor's icon opens a keyboard-accessible picker and saves its logo",
      async () => {
        await page
          .getByRole("button", { name: "Add Sponsor", exact: true })
          .first()
          .click();
        dialog = page.getByRole("dialog").last();
        await chooseFile(
          page,
          dialog.getByRole("button", {
            name: "Choose sponsor logo",
            exact: true,
          }),
          firstLogo,
          true,
        );
        await waitForLoadedImage(selectedPreview());
        assert.equal(
          mutations.length,
          0,
          "Choosing a logo must not create an empty sponsor.",
        );
        assert.equal((await request("/sponsors")).length, 0);
        await dialog
          .getByLabel("Sponsor Name", { exact: true })
          .fill("Logo fixture sponsor");
        const uploaded = page.waitForResponse(
          (response) =>
            /\/api\/sponsors\/[^/]+\/attachments$/.test(response.url()) &&
            response.request().method() === "POST",
        );
        await dialog
          .getByRole("button", { name: "Create Sponsor", exact: true })
          .click();
        assert.equal((await uploaded).ok(), true);
        await waitForLoadedImage(currentLogo());
        assert.equal(await selectedPreview().count(), 0);
        const sponsors = await request("/sponsors");
        assert.equal(sponsors.length, 1);
        sponsorId = sponsors[0].id;
        assert.equal(sponsors[0].attachments.length, 1);
        const logo = sponsors[0].attachments[0];
        attachmentId = logo.id;
        assert.equal(logo.kind, "logo");
        assert.equal(logo.sponsorId, sponsorId);
        assert.equal(logo.name, firstLogo.name);
        const file = await context.request.get(
          base + "/api/attachments/" + attachmentId,
        );
        assert.deepEqual(await file.body(), firstLogo.buffer);
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await page.reload();
        await openSponsor("Logo fixture sponsor");
        await waitForLoadedImage(currentLogo());
        await waitForAllSponsorImages(2400);
      },
    );

    await t.test(
      "A replacement preserves unsaved sponsor edits and attachment ownership",
      async () => {
        await dialog
          .getByLabel("Sponsor Name", { exact: true })
          .fill("Logo fixture updated");
        await chooseFile(
          page,
          dialog.getByRole("button", {
            name: "Change Logo",
            exact: true,
          }),
          replacementLogo,
        );
        await waitForLoadedImage(selectedPreview());
        assert.equal(
          (await request("/sponsors/" + sponsorId)).name,
          "Logo fixture sponsor",
        );
        assert.equal(
          await dialog.getByLabel("Sponsor Name", { exact: true }).inputValue(),
          "Logo fixture updated",
        );
        await saveLogo(
          "Save Changes",
          "/attachments/" + attachmentId + "/replace",
        );
        await waitForAllSponsorImages(1);
        const saved = await request("/sponsors/" + sponsorId);
        assert.equal(saved.name, "Logo fixture updated");
        assert.equal(saved.attachments.length, 1);
        assert.equal(saved.attachments[0].id, attachmentId);
        assert.equal(saved.attachments[0].sponsorId, sponsorId);
        assert.equal(saved.attachments[0].name, replacementLogo.name);
        const file = await context.request.get(
          base + "/api/attachments/" + attachmentId,
        );
        assert.deepEqual(await file.body(), replacementLogo.buffer);
      },
    );

    await t.test(
      "A failed upload keeps the chosen image and permits retry without duplicate sponsors",
      async () => {
        const retryLogo = { ...firstLogo, name: "sponsor-retry.png" };
        await dialog
          .getByLabel("Sponsor Name", { exact: true })
          .fill("Logo fixture retry");
        await chooseFile(
          page,
          dialog.getByRole("button", {
            name: "Change Logo",
            exact: true,
          }),
          retryLogo,
        );
        await waitForLoadedImage(selectedPreview());
        const replaceUrl =
          base + "/api/attachments/" + attachmentId + "/replace";
        await page.route(replaceUrl, async (route) => {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Temporary logo upload failure." }),
          });
        });
        const failed = page.waitForResponse(
          (response) =>
            response.url() === replaceUrl && response.status() === 503,
        );
        await dialog
          .getByRole("button", { name: "Save Changes", exact: true })
          .click();
        await failed;
        await dialog.getByRole("alert").filter({ hasText: /logo/i }).waitFor();
        assert.match(await dialog.getByRole("alert").innerText(), /saved/i);
        await waitForLoadedImage(selectedPreview());
        assert.equal(
          await dialog
            .getByRole("button", { name: "Save Changes", exact: true })
            .isEnabled(),
          true,
        );
        const partial = await request("/sponsors/" + sponsorId);
        assert.equal(partial.name, "Logo fixture retry");
        assert.equal(partial.attachments[0].name, replacementLogo.name);
        assert.equal(partial.attachments[0].id, attachmentId);
        await page.unroute(replaceUrl);
        await saveLogo(
          "Save Changes",
          "/attachments/" + attachmentId + "/replace",
        );
        await waitForAllSponsorImages(2400);
        const sponsors = await request("/sponsors");
        assert.equal(sponsors.length, 1);
        assert.equal(sponsors[0].id, sponsorId);
        assert.equal(sponsors[0].attachments.length, 1);
        assert.equal(sponsors[0].attachments[0].id, attachmentId);
        assert.equal(sponsors[0].attachments[0].name, retryLogo.name);
        assert.equal(
          mutations.filter(
            (entry) =>
              entry.method === "POST" && entry.url === base + "/api/sponsors",
          ).length,
          1,
        );
      },
    );

    await t.test(
      "Closing a pending-only logo selection confirms discard without changing the saved logo",
      async () => {
        const before = await request("/sponsors/" + sponsorId);
        const mutationCount = mutations.length;
        await chooseFile(
          page,
          dialog.getByRole("button", {
            name: "Change Logo",
            exact: true,
          }),
          replacementLogo,
        );
        await waitForLoadedImage(selectedPreview());
        assert.equal(
          await selectedPreview().evaluate((image) => image.naturalWidth),
          1,
        );
        const dismissConfirmation = page.waitForEvent("dialog");
        const firstClose = dialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        const dismissed = await dismissConfirmation;
        assert.equal(dismissed.type(), "confirm");
        assert.match(dismissed.message(), /discard.*unsaved/i);
        await dismissed.dismiss();
        await firstClose;
        await waitForLoadedImage(selectedPreview());
        assert.equal(
          await dialog
            .getByRole("button", { name: "Save Changes", exact: true })
            .isEnabled(),
          true,
        );
        assert.equal(mutations.length, mutationCount);
        const acceptConfirmation = page.waitForEvent("dialog");
        const secondClose = dialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await (await acceptConfirmation).accept();
        await secondClose;
        await dialog.waitFor({ state: "hidden" });
        assert.equal(mutations.length, mutationCount);
        assert.deepEqual(await request("/sponsors/" + sponsorId), before);
        await openSponsor("Logo fixture retry");
        await waitForAllSponsorImages(2400);
        assert.equal(await selectedPreview().count(), 0);
        assert.equal(
          await dialog
            .getByRole("button", { name: "Save Changes", exact: true })
            .isEnabled(),
          false,
        );
      },
    );

    await t.test(
      "Unsupported or oversized selections show errors before changing saved data",
      async () => {
        const before = await request("/sponsors/" + sponsorId);
        const mutationCount = mutations.length;
        await chooseFile(
          page,
          dialog.getByRole("button", {
            name: "Change Logo",
            exact: true,
          }),
          {
            name: "unsupported.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("%PDF-1.7\n"),
          },
        );
        await dialog
          .getByRole("alert")
          .filter({ hasText: /PNG|JPEG|WebP/i })
          .waitFor();
        assert.equal(await selectedPreview().count(), 0);
        const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
        replacementLogo.buffer.copy(oversized);
        await chooseFile(
          page,
          dialog.getByRole("button", {
            name: "Change Logo",
            exact: true,
          }),
          { name: "oversized.png", mimeType: "image/png", buffer: oversized },
        );
        await dialog.getByRole("alert").filter({ hasText: /10 MB/i }).waitFor();
        assert.equal(await selectedPreview().count(), 0);
        assert.equal(mutations.length, mutationCount);
        assert.deepEqual(await request("/sponsors/" + sponsorId), before);
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
      },
    );

    await t.test(
      "Viewers can see the saved logo but cannot upload or replace it",
      async () => {
        const viewerContext = await browser.newContext();
        const login = await viewerContext.request.post(base + "/api/login", {
          headers: { "X-Requested-With": "Maestro" },
          data: { email: "logo-viewer@example.test", password: viewerPassword },
        });
        assert.equal(login.ok(), true);
        const viewer = await viewerContext.newPage();
        viewer.on("pageerror", (error) => errors.push(error.message));
        await viewer.goto(base);
        const record = viewer.locator(".complete-record").filter({
          has: viewer.getByRole("heading", {
            name: "Logo fixture retry",
            exact: true,
          }),
        });
        await record
          .getByRole("button", { name: "View Sponsor", exact: true })
          .click();
        const viewerDialog = viewer.getByRole("dialog").last();
        await viewerDialog
          .locator('.sponsor-logo-display[data-logo-state="saved"]')
          .getByRole("img", { name: "Logo fixture retry logo", exact: true })
          .waitFor();
        assert.equal(
          await viewerDialog
            .getByRole("button", {
              name: /Choose sponsor logo|Upload Logo|Change Logo/,
            })
            .count(),
          0,
        );
        assert.equal(
          await viewerDialog
            .getByLabel("Sponsor logo file", { exact: true })
            .count(),
          0,
        );
        const rejected = await viewerContext.request.post(
          base + "/api/attachments/" + attachmentId + "/replace",
          {
            headers: { "X-Requested-With": "Maestro" },
            multipart: {
              file: {
                name: firstLogo.name,
                mimeType: firstLogo.mimeType,
                buffer: firstLogo.buffer,
              },
            },
          },
        );
        assert.equal(rejected.status(), 403);
        await viewerContext.close();
      },
    );
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => {
      if (server.exitCode !== null) return resolve();
      server.once("exit", resolve);
      server.kill("SIGTERM");
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
