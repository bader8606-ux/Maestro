import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
  "base64",
);

// Real browser chooser events exercise the visible controls; direct file-input
// injection would conceal the disabled picker reported by the user.
async function chooseFiles(page, control, files, keyboard = false) {
  assert.equal(await control.isEnabled(), true);
  const chooser = page.waitForEvent("filechooser");
  if (keyboard) {
    await control.focus();
    await control.press("Enter");
  } else await control.click();
  const picker = await chooser;
  assert.equal(picker.isMultiple(), true);
  await picker.setFiles(files);
}

await test("Approval and purchase order pickers stage, persist and retry sponsor attachments", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "maestro-attachment-ui-"));
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
        () => reject(new Error("Attachment test server startup timed out.")),
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
        reject(new Error("Attachment test server exited before startup."));
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
      name: "Attachment Test Administrator",
      email: "attachment-admin@example.test",
      password: randomBytes(24).toString("hex"),
    });
    const viewerPassword = randomBytes(24).toString("hex");
    await request("/users", "POST", {
      name: "Attachment Test Viewer",
      email: "attachment-viewer@example.test",
      password: viewerPassword,
      role: "viewer",
    });
    const exported = await context.request.get(base + "/api/export/pdf");
    assert.equal(exported.ok(), true);
    const pdf = await exported.body();
    const approvalFiles = [
      { name: "approval-image.png", mimeType: "image/png", buffer: png },
      {
        name: "approval-document.pdf",
        mimeType: "application/pdf",
        buffer: pdf,
      },
    ];
    const poFiles = [
      { name: "purchase-order.pdf", mimeType: "application/pdf", buffer: pdf },
    ];
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
    let dialog, sponsorId;
    const pending = () => dialog.locator(".pending-attachment");
    const choose = (kind, files, keyboard = false) =>
      chooseFiles(
        page,
        dialog.getByRole("button", {
          name:
            kind === "approval"
              ? "Choose approval attachments"
              : "Choose purchase order attachments",
          exact: true,
        }),
        files,
        keyboard,
      );
    const section = (kind) =>
      dialog.locator(".attachment-section").filter({
        has: page.getByRole("heading", {
          name:
            kind === "approval"
              ? "Approval Attachments"
              : "Purchase Order Attachments",
          exact: true,
        }),
      });
    const openSponsor = async (name) => {
      const record = page
        .locator(".complete-record")
        .filter({ has: page.getByRole("heading", { name, exact: true }) });
      await record
        .getByRole("button", { name: "Edit Sponsor", exact: true })
        .click();
      dialog = page.getByRole("dialog").last();
      await dialog.getByLabel("Sponsor Name", { exact: true }).waitFor();
      await dialog
        .getByRole("tab", { name: "Attachments", exact: true })
        .click();
    };
    const save = async (name = "Save Changes") => {
      await dialog.getByRole("button", { name, exact: true }).click();
      await pending().first().waitFor({ state: "hidden" });
      await dialog.getByRole("alert").waitFor({ state: "hidden" });
    };

    await t.test(
      "Both pickers open before creating a sponsor and save multiple files to the right sections",
      async () => {
        await page
          .getByRole("button", { name: "Add Sponsor", exact: true })
          .first()
          .click();
        dialog = page.getByRole("dialog").last();
        await dialog
          .getByRole("tab", { name: "Attachments", exact: true })
          .click();
        await choose("approval", approvalFiles, true);
        await dialog
          .getByText(approvalFiles[0].name, { exact: true })
          .waitFor();
        await choose("purchase-order", poFiles);
        await dialog.getByText(poFiles[0].name, { exact: true }).waitFor();
        assert.equal(await pending().count(), 3);
        assert.equal(
          mutations.length,
          0,
          "Selecting documents must not create a blank sponsor.",
        );
        assert.equal((await request("/sponsors")).length, 0);
        await dialog
          .getByRole("tab", { name: "Overview", exact: true })
          .click();
        await dialog
          .getByLabel("Sponsor Name", { exact: true })
          .fill("Attachment fixture sponsor");
        await dialog
          .getByRole("tab", { name: "Attachments", exact: true })
          .click();
        await save("Create Sponsor");
        const sponsors = await request("/sponsors");
        assert.equal(sponsors.length, 1);
        sponsorId = sponsors[0].id;
        assert.equal(sponsors[0].attachments.length, 3);
        for (const [kind, files] of [
          ["approval", approvalFiles],
          ["purchase-order", poFiles],
        ]) {
          const attachments = sponsors[0].attachments.filter(
            (entry) => entry.kind === kind,
          );
          assert.deepEqual(
            attachments.map((entry) => entry.name).sort(),
            files.map((file) => file.name).sort(),
          );
          for (const file of files) {
            const attachment = attachments.find(
              (entry) => entry.name === file.name,
            );
            assert.equal(attachment.sponsorId, sponsorId);
            const downloaded = await context.request.get(
              base + "/api/attachments/" + attachment.id,
            );
            assert.deepEqual(await downloaded.body(), file.buffer);
            await section(kind).getByText(file.name, { exact: true }).waitFor();
          }
        }
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await page.reload();
        await openSponsor("Attachment fixture sponsor");
        assert.equal(
          await section("approval").locator(".attachment-card").count(),
          2,
        );
        assert.equal(
          await section("purchase-order").locator(".attachment-card").count(),
          1,
        );
      },
    );

    await t.test(
      "Adding a document to an edited sponsor preserves its unsaved fields",
      async () => {
        await dialog
          .getByRole("tab", { name: "Overview", exact: true })
          .click();
        await dialog
          .getByLabel("Sponsor Name", { exact: true })
          .fill("Attachment fixture updated");
        await dialog
          .getByRole("tab", { name: "Attachments", exact: true })
          .click();
        const file = {
          name: "approval-dirty-edit.png",
          mimeType: "image/png",
          buffer: png,
        };
        await choose("approval", [file]);
        await dialog.getByText(file.name, { exact: true }).waitFor();
        assert.equal(
          (await request("/sponsors/" + sponsorId)).name,
          "Attachment fixture sponsor",
        );
        await save();
        const saved = await request("/sponsors/" + sponsorId);
        assert.equal(saved.name, "Attachment fixture updated");
        assert.equal(saved.attachments.length, 4);
        const uploaded = saved.attachments.find(
          (entry) => entry.name === file.name,
        );
        assert.equal(uploaded.sponsorId, sponsorId);
        assert.equal(uploaded.kind, "approval");
      },
    );

    await t.test(
      "A second-section failure retains only that batch and retry does not duplicate the successful batch",
      async () => {
        await dialog
          .getByRole("tab", { name: "Overview", exact: true })
          .click();
        await dialog
          .getByLabel("Sponsor Name", { exact: true })
          .fill("Attachment fixture retry");
        await dialog
          .getByRole("tab", { name: "Attachments", exact: true })
          .click();
        const first = {
          name: "approval-before-failure.png",
          mimeType: "image/png",
          buffer: png,
        };
        const second = {
          name: "purchase-order-retry.pdf",
          mimeType: "application/pdf",
          buffer: pdf,
        };
        await choose("approval", [first]);
        await choose("purchase-order", [second]);
        const uploadUrl = base + "/api/sponsors/" + sponsorId + "/attachments";
        await page.route(uploadUrl, async (route) => {
          const body = route.request().postDataBuffer()?.toString() || "";
          if (body.includes('name="kind"\r\n\r\npurchase-order')) {
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                error: "Temporary purchase order upload failure.",
              }),
            });
          } else await route.continue();
        });
        const failed = page.waitForResponse(
          (response) =>
            response.url() === uploadUrl && response.status() === 503,
        );
        await dialog
          .getByRole("button", { name: "Save Changes", exact: true })
          .click();
        await failed;
        await dialog.getByRole("alert").filter({ hasText: /saved/i }).waitFor();
        assert.match(
          await dialog.getByRole("alert").innerText(),
          /attachment|purchase order/i,
        );
        assert.equal(await pending().count(), 1);
        assert.equal(
          await section("approval").locator(".pending-attachment").count(),
          0,
        );
        assert.equal(
          await section("purchase-order")
            .locator(".pending-attachment")
            .count(),
          1,
        );
        assert.equal(
          await dialog
            .getByRole("button", { name: "Save Changes", exact: true })
            .isEnabled(),
          true,
        );
        const partial = await request("/sponsors/" + sponsorId);
        assert.equal(partial.name, "Attachment fixture retry");
        assert.equal(partial.attachments.length, 5);
        assert.equal(
          partial.attachments.filter((entry) => entry.name === first.name)
            .length,
          1,
        );
        assert.equal(
          partial.attachments.filter((entry) => entry.name === second.name)
            .length,
          0,
        );
        const successfulId = partial.attachments.find(
          (entry) => entry.name === first.name,
        ).id;
        await page.unroute(uploadUrl);
        await save();
        const sponsors = await request("/sponsors");
        assert.equal(sponsors.length, 1);
        assert.equal(sponsors[0].id, sponsorId);
        assert.equal(sponsors[0].attachments.length, 6);
        assert.equal(
          sponsors[0].attachments.filter((entry) => entry.name === first.name)
            .length,
          1,
        );
        assert.equal(
          sponsors[0].attachments.find((entry) => entry.name === first.name).id,
          successfulId,
        );
        assert.equal(
          sponsors[0].attachments.filter((entry) => entry.name === second.name)
            .length,
          1,
        );
        assert.equal(
          mutations.filter(
            (entry) =>
              entry.url === base + "/api/sponsors" && entry.method === "POST",
          ).length,
          1,
        );
      },
    );

    await t.test(
      "A lost response after the server commits is reconciled without staging a duplicate upload",
      async () => {
        const first = {
          name: "approval-before-lost-response.png",
          mimeType: "image/png",
          buffer: png,
        };
        const second = {
          name: "purchase-order-lost-response.pdf",
          mimeType: "application/pdf",
          buffer: pdf,
        };
        await choose("approval", [first]);
        await choose("purchase-order", [second]);
        const uploadUrl = base + "/api/sponsors/" + sponsorId + "/attachments";
        await page.route(uploadUrl, async (route) => {
          const body = route.request().postDataBuffer()?.toString() || "";
          if (body.includes('name="kind"\r\n\r\npurchase-order')) {
            const committed = await route.fetch();
            assert.equal(committed.ok(), true);
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "The upload response was lost." }),
            });
          } else await route.continue();
        });
        const lost = page.waitForResponse(
          (response) =>
            response.url() === uploadUrl && response.status() === 503,
        );
        await dialog
          .getByRole("button", { name: "Save Changes", exact: true })
          .click();
        await lost;
        await pending().first().waitFor({ state: "hidden" });
        const saved = await request("/sponsors/" + sponsorId);
        assert.equal(saved.attachments.length, 8);
        for (const file of [first, second]) {
          assert.equal(
            saved.attachments.filter((entry) => entry.name === file.name)
              .length,
            1,
          );
        }
        await page.unroute(uploadUrl);
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await page.reload();
        await openSponsor("Attachment fixture retry");
        assert.equal(await pending().count(), 0);
        assert.equal(
          await dialog
            .getByRole("button", { name: "Save Changes", exact: true })
            .isEnabled(),
          false,
        );
        assert.equal((await request("/sponsors")).length, 1);
        assert.equal(
          (await request("/sponsors/" + sponsorId)).attachments.length,
          8,
        );
      },
    );

    await t.test(
      "An uncertain committed upload is verified on retry before another POST can duplicate it",
      async () => {
        const file = {
          name: "purchase-order-uncertain-response.pdf",
          mimeType: "application/pdf",
          buffer: pdf,
        };
        await choose("purchase-order", [file]);
        await dialog.getByText(file.name, { exact: true }).waitFor();
        const uploadUrl = base + "/api/sponsors/" + sponsorId + "/attachments";
        const sponsorUrl = base + "/api/sponsors/" + sponsorId;
        await page.route(uploadUrl, async (route) => {
          const committed = await route.fetch();
          assert.equal(committed.ok(), true);
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: "The committed upload response was lost.",
            }),
          });
        });
        await page.route(sponsorUrl, (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: "The workspace could not be read for verification.",
            }),
          }),
        );
        const lost = page.waitForResponse(
          (response) =>
            response.url() === uploadUrl && response.status() === 503,
        );
        await dialog
          .getByRole("button", { name: "Save Changes", exact: true })
          .click();
        await lost;
        await dialog.getByRole("alert").filter({ hasText: /saved/i }).waitFor();
        assert.equal(await pending().count(), 1);
        assert.equal(
          await dialog
            .getByRole("button", { name: "Save Changes", exact: true })
            .isEnabled(),
          true,
        );
        const committed = await request("/sponsors/" + sponsorId);
        assert.equal(committed.name, "Attachment fixture retry");
        assert.equal(committed.attachments.length, 9);
        assert.equal(
          committed.attachments.filter((entry) => entry.name === file.name)
            .length,
          1,
        );
        const committedId = committed.attachments.find(
          (entry) => entry.name === file.name,
        ).id;
        const postCount = mutations.filter(
          (entry) => entry.url === uploadUrl && entry.method === "POST",
        ).length;
        const unavailableVerification = page.waitForResponse(
          (response) =>
            response.url() === sponsorUrl && response.status() === 503,
        );
        await dialog
          .getByRole("button", { name: "Save Changes", exact: true })
          .click();
        await unavailableVerification;
        await dialog
          .getByRole("alert")
          .filter({ hasText: /verif|read/i })
          .waitFor();
        assert.equal(await pending().count(), 1);
        assert.equal(
          mutations.filter(
            (entry) => entry.url === uploadUrl && entry.method === "POST",
          ).length,
          postCount,
        );
        assert.equal(
          (await request("/sponsors/" + sponsorId)).attachments.length,
          9,
        );
        await page.unroute(uploadUrl);
        await page.unroute(sponsorUrl);
        await save();
        assert.equal(
          mutations.filter(
            (entry) => entry.url === uploadUrl && entry.method === "POST",
          ).length,
          postCount,
        );
        const verified = await request("/sponsors/" + sponsorId);
        assert.equal(verified.attachments.length, 9);
        assert.equal(
          verified.attachments.filter((entry) => entry.name === file.name)
            .length,
          1,
        );
        assert.equal(
          verified.attachments.find((entry) => entry.name === file.name).id,
          committedId,
        );
        assert.equal((await request("/sponsors")).length, 1);
      },
    );

    await t.test(
      "Invalid file types, empty files, oversized files and more than ten files are rejected without mutations",
      async () => {
        const before = await request("/sponsors/" + sponsorId);
        const mutationCount = mutations.length;
        const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
        png.copy(oversized);
        const invalidSelections = [
          {
            files: [
              {
                name: "unsupported.txt",
                mimeType: "text/plain",
                buffer: Buffer.from("attachment"),
              },
            ],
            error: /PNG|JPEG|WebP|PDF/i,
          },
          {
            files: [
              {
                name: "empty.png",
                mimeType: "image/png",
                buffer: Buffer.alloc(0),
              },
            ],
            error: /empty/i,
          },
          {
            files: [
              {
                name: "oversized.png",
                mimeType: "image/png",
                buffer: oversized,
              },
            ],
            error: /10 MB/i,
          },
          {
            files: Array.from({ length: 11 }, (_, index) => ({
              name: "batch-" + index + ".png",
              mimeType: "image/png",
              buffer: png,
            })),
            error: /10.*files|files.*10/i,
          },
        ];
        for (const { files, error } of invalidSelections) {
          await choose("approval", files);
          await dialog.getByRole("alert").filter({ hasText: error }).waitFor();
          assert.equal(await pending().count(), 0);
        }
        assert.equal(mutations.length, mutationCount);
        assert.deepEqual(await request("/sponsors/" + sponsorId), before);
      },
    );

    await t.test(
      "Discard confirmation protects a pending-only batch on an unchanged sponsor",
      async () => {
        const before = await request("/sponsors/" + sponsorId);
        const mutationCount = mutations.length;
        const staged = {
          name: "discard-purchase-order.pdf",
          mimeType: "application/pdf",
          buffer: pdf,
        };
        await choose("purchase-order", [staged]);
        await dialog.getByText(staged.name, { exact: true }).waitFor();
        const firstConfirmation = page.waitForEvent("dialog");
        const firstClose = dialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        const dismissed = await firstConfirmation;
        assert.equal(dismissed.type(), "confirm");
        assert.match(dismissed.message(), /discard.*unsaved/i);
        await dismissed.dismiss();
        await firstClose;
        assert.equal(await pending().count(), 1);
        assert.equal(
          await dialog
            .getByRole("button", { name: "Save Changes", exact: true })
            .isEnabled(),
          true,
        );
        const secondConfirmation = page.waitForEvent("dialog");
        const secondClose = dialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await (await secondConfirmation).accept();
        await secondClose;
        await dialog.waitFor({ state: "hidden" });
        assert.equal(mutations.length, mutationCount);
        assert.deepEqual(await request("/sponsors/" + sponsorId), before);
        await openSponsor("Attachment fixture retry");
        assert.equal(await pending().count(), 0);
        assert.equal(
          await dialog.getByText(staged.name, { exact: true }).count(),
          0,
        );
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
      },
    );

    await t.test(
      "Viewers can read saved attachments but cannot select or upload new files",
      async () => {
        const viewerContext = await browser.newContext();
        const login = await viewerContext.request.post(base + "/api/login", {
          headers: { "X-Requested-With": "Maestro" },
          data: {
            email: "attachment-viewer@example.test",
            password: viewerPassword,
          },
        });
        assert.equal(login.ok(), true);
        const viewer = await viewerContext.newPage();
        viewer.on("pageerror", (error) => errors.push(error.message));
        await viewer.goto(base);
        const record = viewer.locator(".complete-record").filter({
          has: viewer.getByRole("heading", {
            name: "Attachment fixture retry",
            exact: true,
          }),
        });
        await record
          .getByRole("button", { name: "View Sponsor", exact: true })
          .click();
        const viewerDialog = viewer.getByRole("dialog").last();
        await viewerDialog
          .getByRole("tab", { name: "Attachments", exact: true })
          .click();
        assert.equal(await viewerDialog.locator(".attachment-card").count(), 9);
        assert.equal(
          await viewerDialog
            .getByRole("button", {
              name: /Choose approval attachments|Choose purchase order attachments/,
            })
            .count(),
          0,
        );
        assert.equal(
          await viewerDialog
            .getByLabel("Upload approval attachments", { exact: true })
            .count(),
          0,
        );
        assert.equal(
          await viewerDialog
            .getByLabel("Upload purchase order attachments", { exact: true })
            .count(),
          0,
        );
        const rejected = await viewerContext.request.post(
          base + "/api/sponsors/" + sponsorId + "/attachments",
          {
            headers: { "X-Requested-With": "Maestro" },
            multipart: {
              kind: "approval",
              files: { name: "viewer.png", mimeType: "image/png", buffer: png },
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
