import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const logoBytes = readFileSync("public/brand/maestro-logo.png");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sponsorName =
  "Logo clarity fixture with a long sponsor name for the mobile layout";
const emptyName = "Empty logo display fixture";

const sponsorInput = (name) => ({
  name,
  packageId: "",
  contact: "",
  mobile: "",
  email: "",
  approval: "Not Approved",
  approvalDate: "",
  poIssued: false,
  poNumber: "",
  poDate: "",
  value: 1000,
  payments: [],
  benefits: [],
  notes: "",
});

await test("Sponsor logos are clear, previewable and editable without altering files when the background changes", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "maestro-logo-display-"));
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
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error("Logo display fixture startup timed out.")),
        30000,
      );
      server.stdout.on("data", (data) => {
        output += data;
        const match = output.match(/listening on port (\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve("http://127.0.0.1:" + match[1]);
        }
      });
      server.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Logo display fixture exited before startup."));
      });
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      acceptDownloads: true,
    });
    const request = async (url, method = "GET", data) => {
      const response = await context.request.fetch(base + "/api" + url, {
        method,
        headers: { "X-Requested-With": "Maestro" },
        ...(data === undefined ? {} : { data }),
      });
      assert.equal(response.ok(), true, "Fixture request failed: " + url);
      return response.json();
    };
    await request("/setup", "POST", {
      token: readFileSync(path.join(dir, "setup-token"), "utf8"),
      name: "Logo Display Fixture Administrator",
      email: "logo-display-admin@example.test",
      password: randomBytes(24).toString("hex"),
    });
    const viewerPassword = randomBytes(24).toString("hex");
    await request("/users", "POST", {
      name: "Logo Display Fixture Viewer",
      email: "logo-display-viewer@example.test",
      password: viewerPassword,
      role: "viewer",
    });
    const saved = await request("/sponsors", "POST", sponsorInput(sponsorName));
    const empty = await request("/sponsors", "POST", sponsorInput(emptyName));
    const uploaded = await context.request.post(
      base + "/api/sponsors/" + saved.id + "/attachments",
      {
        headers: { "X-Requested-With": "Maestro" },
        multipart: {
          kind: "logo",
          files: {
            name: "logo-clarity-original.png",
            mimeType: "image/png",
            buffer: logoBytes,
          },
        },
      },
    );
    assert.equal(uploaded.ok(), true);
    const attached = await uploaded.json();
    const logo = attached.attachments.find(
      (attachment) => attachment.kind === "logo",
    );
    const snapshot = async () => {
      const sponsor = await request("/sponsors/" + saved.id);
      const response = await context.request.get(
        base + "/api/attachments/" + logo.id,
      );
      assert.equal(response.ok(), true);
      return { sponsor, fileHash: hash(await response.body()) };
    };
    const original = await snapshot();
    assert.equal(original.fileHash, hash(logoBytes));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    const mutations = [];
    page.on("request", (request) => {
      if (
        ["POST", "PUT", "DELETE"].includes(request.method()) &&
        /\/api\/(sponsors|attachments)(\/|$)/.test(request.url())
      )
        mutations.push(request.url());
    });
    await page.goto(base);
    const record = (name = sponsorName) =>
      page.locator(".complete-record").filter({
        has: page.getByRole("heading", { name, exact: true }),
      });
    await record().waitFor();
    let dialog;
    const open = async (name = sponsorName) => {
      await record(name)
        .getByRole("button", { name: "Edit Sponsor", exact: true })
        .click();
      dialog = page.getByRole("dialog").last();
      await dialog.getByLabel("Sponsor Name", { exact: true }).waitFor();
    };
    const waitForImage = async (image) => {
      await image.waitFor();
      await image.evaluate((element) => {
        if (element.complete && element.naturalWidth > 0) return;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error("Logo display image did not finish loading.")),
            10000,
          );
          element.addEventListener(
            "load",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          element.addEventListener(
            "error",
            () => {
              clearTimeout(timer);
              reject(new Error("Logo display image could not load."));
            },
            { once: true },
          );
        });
      });
      assert.equal(
        await image.evaluate((element) => element.naturalWidth),
        2400,
      );
    };
    const changeBackground = async (
      scope,
      selector = ".sponsor-logo-frame",
    ) => {
      const frame = scope.locator(selector);
      await scope
        .getByRole("button", { name: "Light background", exact: true })
        .click();
      const light = await frame.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      assert.equal(
        await scope
          .getByRole("button", { name: "Light background", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await scope
        .getByRole("button", { name: "Dark background", exact: true })
        .click();
      const dark = await frame.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      assert.notEqual(
        dark,
        light,
        "Background controls must change the actual rendered background.",
      );
      assert.equal(
        await scope
          .getByRole("button", { name: "Dark background", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
    };
    const previewAndDownload = async (scope, fileName, keyboard = false) => {
      const control = scope.getByRole("button", {
        name: "Preview sponsor logo",
        exact: true,
      });
      if (keyboard) {
        await control.focus();
        await control.press("Enter");
      } else await control.click();
      const preview = page.getByRole("dialog", {
        name: "Preview " + fileName,
        exact: true,
      });
      await waitForImage(
        preview.getByRole("img", { name: fileName, exact: true }),
      );
      await changeBackground(preview, ".preview-body");
      const image = preview.getByRole("img", { name: fileName, exact: true });
      const beforeZoom = (await image.boundingBox()).width;
      await preview
        .getByRole("button", { name: "Zoom in", exact: true })
        .click();
      assert.match(
        await preview.locator(".preview-toolbar").innerText(),
        /125%/,
      );
      assert.ok((await image.boundingBox()).width >= beforeZoom * 1.24);
      const downloadPromise = page.waitForEvent("download");
      await preview
        .getByRole("link", { name: "Download attachment", exact: true })
        .click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), fileName);
      assert.equal(await download.failure(), null);
      assert.equal(hash(readFileSync(await download.path())), hash(logoBytes));
      await preview
        .getByRole("button", { name: "Close preview", exact: true })
        .click();
      await preview.waitFor({ state: "hidden" });
    };

    await t.test(
      "Saved logos show their full proportions and sponsor name, with preview, zoom and download from the frame",
      async () => {
        const display = record().locator(".sponsor-logo-display");
        await waitForImage(
          display.getByRole("img", {
            name: sponsorName + " logo",
            exact: true,
          }),
        );
        const frame = display.locator(".sponsor-logo-frame");
        const dimensions = await frame.boundingBox();
        assert.ok(dimensions.width >= 120 && dimensions.height >= 80);
        const image = display.getByRole("img", {
          name: sponsorName + " logo",
          exact: true,
        });
        assert.equal(
          await image.evaluate(
            (element) => getComputedStyle(element).objectFit,
          ),
          "contain",
        );
        const name = display.locator(".sponsor-logo-name");
        assert.equal(await name.innerText(), sponsorName);
        assert.ok(
          (await name.boundingBox()).y >= dimensions.y + dimensions.height,
        );
        await previewAndDownload(display, logo.name, true);
        await open();
        await previewAndDownload(
          dialog.locator(".sponsor-logo-display"),
          logo.name,
        );
        assert.equal(
          await dialog
            .getByRole("button", { name: "Change Logo", exact: true })
            .isVisible(),
          true,
        );
        assert.equal(
          await dialog
            .getByRole("button", { name: "Save Changes", exact: true })
            .isEnabled(),
          false,
        );
      },
    );

    await t.test(
      "Light and dark backgrounds are presentation only and leave saved file bytes, metadata and revision unchanged",
      async () => {
        await changeBackground(dialog.locator(".sponsor-logo-display"));
        assert.equal(
          await dialog
            .getByRole("button", { name: "Save Changes", exact: true })
            .isEnabled(),
          false,
        );
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await changeBackground(record().locator(".sponsor-logo-display"));
        assert.equal(mutations.length, 0);
        assert.deepEqual(await snapshot(), original);
      },
    );

    await t.test(
      "An empty logo has an explicit Upload Logo action and a staged image can be previewed and downloaded before saving",
      async () => {
        await open(emptyName);
        const display = dialog.locator(".sponsor-logo-display");
        assert.equal(
          await display
            .getByText("No logo uploaded", { exact: true })
            .isVisible(),
          true,
        );
        assert.equal(
          await display.locator(".sponsor-logo-name").innerText(),
          emptyName,
        );
        const chooserPromise = page.waitForEvent("filechooser");
        const upload = display.getByRole("button", {
          name: "Upload Logo",
          exact: true,
        });
        await upload.focus();
        await upload.press("Enter");
        await (
          await chooserPromise
        ).setFiles({
          name: "logo-clarity-pending.png",
          mimeType: "image/png",
          buffer: logoBytes,
        });
        await waitForImage(
          display.getByRole("img", { name: emptyName + " logo", exact: true }),
        );
        await previewAndDownload(display, "logo-clarity-pending.png", true);
        await changeBackground(display);
        assert.equal(
          await display
            .getByRole("button", { name: "Change Logo", exact: true })
            .isVisible(),
          true,
        );
        assert.equal(
          (await request("/sponsors/" + empty.id)).attachments.length,
          0,
        );
        assert.equal(mutations.length, 0);
        await dialog
          .getByRole("button", { name: "Remove selected logo", exact: true })
          .click();
        await display.getByText("No logo uploaded", { exact: true }).waitFor();
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
      },
    );

    await t.test(
      "Viewers can change contrast, preview and download a saved logo, with no upload or replacement controls",
      async () => {
        const viewerContext = await browser.newContext({
          acceptDownloads: true,
        });
        try {
          const login = await viewerContext.request.post(base + "/api/login", {
            headers: { "X-Requested-With": "Maestro" },
            data: {
              email: "logo-display-viewer@example.test",
              password: viewerPassword,
            },
          });
          assert.equal(login.ok(), true);
          const viewer = await viewerContext.newPage();
          viewer.setDefaultTimeout(10000);
          viewer.on("pageerror", (error) => errors.push(error.message));
          await viewer.goto(base);
          const viewedRecord = viewer.locator(".complete-record").filter({
            has: viewer.getByRole("heading", {
              name: sponsorName,
              exact: true,
            }),
          });
          await viewedRecord
            .getByRole("button", { name: "View Sponsor", exact: true })
            .click();
          const viewedDialog = viewer.getByRole("dialog").last();
          const display = viewedDialog.locator(".sponsor-logo-display");
          await waitForImage(
            display.getByRole("img", {
              name: sponsorName + " logo",
              exact: true,
            }),
          );
          await changeBackground(display);
          assert.equal(
            await viewedDialog
              .getByRole("button", {
                name: /Upload Logo|Change Logo|Choose sponsor logo|Delete sponsor logo/,
              })
              .count(),
            0,
          );
          assert.equal(
            await viewedDialog
              .getByLabel("Sponsor logo file", { exact: true })
              .count(),
            0,
          );
          const frame = display.getByRole("button", {
            name: "Preview sponsor logo",
            exact: true,
          });
          await frame.focus();
          await frame.press("Enter");
          const preview = viewer.getByRole("dialog", {
            name: "Preview " + logo.name,
            exact: true,
          });
          await waitForImage(
            preview.getByRole("img", { name: logo.name, exact: true }),
          );
          await preview
            .getByRole("button", { name: "Zoom in", exact: true })
            .click();
          assert.match(
            await preview.locator(".preview-toolbar").innerText(),
            /125%/,
          );
          const downloaded = await viewerContext.request.get(
            base +
              (await preview
                .getByRole("link", { name: "Download attachment", exact: true })
                .getAttribute("href")),
          );
          assert.equal(downloaded.ok(), true);
          assert.equal(hash(await downloaded.body()), hash(logoBytes));
          assert.deepEqual(await snapshot(), original);
        } finally {
          await viewerContext.close();
        }
      },
    );

    await t.test(
      "A cross-origin signed Storage logo downloads with its original bytes while the preview keeps its signed URL unchanged",
      async () => {
        const storageRequests = [];
        const storagePath =
          "/storage/v1/object/sign/maestro-files/fixture-logo.png";
        const storage = createServer((req, res) => {
          const url = new URL(req.url, "http://127.0.0.1");
          storageRequests.push(url);
          if (
            url.pathname !== storagePath ||
            url.searchParams.get("token") !== "opaque-fixture-signature"
          ) {
            res.writeHead(403);
            res.end();
            return;
          }
          const headers = {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
          };
          // Like Storage, a preview is inline; the download flag is needed to
          // return attachment disposition across the different browser origin.
          if (url.searchParams.has("download"))
            headers["Content-Disposition"] =
              'attachment; filename="' + url.searchParams.get("download") + '"';
          res.writeHead(200, headers);
          res.end(logoBytes);
        });
        let cloudPage;
        try {
          const storageOrigin = await new Promise((resolve) => {
            storage.listen(0, "127.0.0.1", () =>
              resolve("http://127.0.0.1:" + storage.address().port),
            );
          });
          assert.notEqual(storageOrigin, base);
          const signedUrl =
            storageOrigin +
            storagePath +
            "?token=opaque-fixture-signature&width=2400";
          // Chromium treats a fulfilled test page as needing permission for a
          // different loopback server. Limit this to the disposable test origin.
          await context.grantPermissions(["local-network-access"], {
            origin: base,
          });
          cloudPage = await context.newPage();
          cloudPage.setDefaultTimeout(10000);
          cloudPage.on("pageerror", (error) => errors.push(error.message));
          const rows = await request("/sponsors");
          for (const row of rows)
            if (row.id === saved.id)
              for (const attachment of row.attachments)
                if (attachment.id === logo.id) attachment.url = signedUrl;
          await cloudPage.route(base + "/api/sponsors", (route) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(rows),
            }),
          );
          // The local Node deployment only permits its own uploaded images.
          // Pages uses cross-origin Storage. Allow exactly the loopback fixture
          // origin in this page's image directive, keeping every other rule.
          await cloudPage.route(base + "/", async (route) => {
            const response = await route.fetch();
            const headers = response.headers();
            assert.match(headers["content-security-policy"], /img-src /);
            headers["content-security-policy"] = headers[
              "content-security-policy"
            ].replace(
              /img-src([^;]+)/,
              (_, sources) => "img-src" + sources + " " + storageOrigin,
            );
            await route.fulfill({ response, headers });
          });
          await cloudPage.goto(base);
          const cloudRecord = cloudPage.locator(".complete-record").filter({
            has: cloudPage.getByRole("heading", {
              name: sponsorName,
              exact: true,
            }),
          });
          await cloudRecord
            .getByRole("button", { name: "Preview sponsor logo", exact: true })
            .click();
          const preview = cloudPage.getByRole("dialog", {
            name: "Preview " + logo.name,
            exact: true,
          });
          const image = preview.getByRole("img", {
            name: logo.name,
            exact: true,
          });
          await waitForImage(image);
          assert.equal(await image.getAttribute("src"), signedUrl);
          const downloadLink = preview.getByRole("link", {
            name: "Download attachment",
            exact: true,
          });
          const downloadUrl = new URL(await downloadLink.getAttribute("href"));
          assert.equal(downloadUrl.origin, storageOrigin);
          assert.equal(downloadUrl.pathname, storagePath);
          assert.equal(
            downloadUrl.searchParams.get("token"),
            "opaque-fixture-signature",
          );
          assert.equal(downloadUrl.searchParams.get("width"), "2400");
          assert.equal(downloadUrl.searchParams.get("download"), logo.name);
          const downloadPromise = cloudPage.waitForEvent("download");
          await downloadLink.click();
          const download = await downloadPromise;
          assert.equal(download.suggestedFilename(), logo.name);
          assert.equal(await download.failure(), null);
          assert.equal(
            hash(readFileSync(await download.path())),
            hash(logoBytes),
          );
          assert.ok(
            storageRequests.some((url) => !url.searchParams.has("download")),
          );
          assert.ok(
            storageRequests.some(
              (url) => url.searchParams.get("download") === logo.name,
            ),
          );
          assert.equal(await image.getAttribute("src"), signedUrl);
          assert.deepEqual(await snapshot(), original);
        } finally {
          if (cloudPage) await cloudPage.close();
          await context.clearPermissions();
          await new Promise((resolve) => {
            storage.close(resolve);
            storage.closeAllConnections();
          });
        }
      },
    );

    await t.test(
      "Logo frames, long sponsor names and contrast controls stay usable on tablet and mobile",
      async () => {
        await open();
        for (const width of [834, 390, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          const display = dialog.locator(".sponsor-logo-display");
          assert.equal(
            await display
              .getByRole("button", { name: "Change Logo", exact: true })
              .isVisible(),
            true,
          );
          for (const name of ["Light background", "Dark background"])
            assert.equal(
              await display
                .getByRole("button", { name, exact: true })
                .isVisible(),
              true,
            );
          assert.equal(
            await dialog.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
            true,
            "Sponsor dialog overflows at " + width,
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
            "Page overflows at " + width,
          );
          await display
            .getByRole("button", { name: "Preview sponsor logo", exact: true })
            .click();
          const preview = page.getByRole("dialog", {
            name: "Preview " + logo.name,
            exact: true,
          });
          await waitForImage(
            preview.getByRole("img", { name: logo.name, exact: true }),
          );
          assert.equal(
            await preview
              .locator(".preview-toolbar")
              .evaluate(
                (element) => element.scrollWidth <= element.clientWidth,
              ),
            true,
            "Logo preview toolbar overflows at " + width,
          );
          for (const name of [
            "Light background",
            "Dark background",
            "Zoom in",
            "Close preview",
          ]) {
            const box = await preview
              .getByRole("button", { name, exact: true })
              .boundingBox();
            assert.ok(
              box.x >= 0 && box.x + box.width <= width,
              name + " falls outside the preview at " + width,
            );
          }
          await changeBackground(preview, ".preview-body");
          await preview
            .getByRole("button", { name: "Close preview", exact: true })
            .click();
        }
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page.screenshot({
          path: "/tmp/maestro-logo-display-mobile.png",
          fullPage: true,
        });
        assert.equal(mutations.length, 0);
        assert.deepEqual(await snapshot(), original);
        assert.deepEqual(errors, []);
      },
    );
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
