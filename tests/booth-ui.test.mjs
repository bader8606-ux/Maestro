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
const labels = {
  "booth-location": "Booth Location Attachments",
  "booth-design": "Booth Design Attachments",
};

await test("Booth dimensions and separate location/design attachments are editable, persistent and visible to viewers", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "maestro-booth-ui-"));
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
        () => reject(new Error("Booth test server startup timed out.")),
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
        reject(new Error("Booth test server exited before startup."));
      });
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
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
      name: "Booth Fixture Administrator",
      email: "booth-admin@example.test",
      password: randomBytes(24).toString("hex"),
    });
    const viewerPassword = randomBytes(24).toString("hex");
    await request("/users", "POST", {
      name: "Booth Fixture Viewer",
      email: "booth-viewer@example.test",
      password: viewerPassword,
      role: "viewer",
    });
    const exportResponse = await context.request.get(base + "/api/export/pdf");
    assert.equal(exportResponse.ok(), true);
    const pdf = await exportResponse.body();
    const locationFiles = [
      { name: "booth-map.png", mimeType: "image/png", buffer: png },
      { name: "booth-map.pdf", mimeType: "application/pdf", buffer: pdf },
    ];
    const designFiles = [
      { name: "booth-design.png", mimeType: "image/png", buffer: png },
      { name: "booth-design.pdf", mimeType: "application/pdf", buffer: pdf },
    ];
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    const mutations = [];
    page.on("request", (request) => {
      if (
        ["POST", "PUT", "DELETE"].includes(request.method()) &&
        /\/api\/(sponsors|attachments)(\/|$)/.test(request.url())
      )
        mutations.push({ url: request.url(), method: request.method() });
    });
    await page.goto(base);
    await page
      .getByRole("heading", { name: "Digital Government Forum", exact: true })
      .waitFor();
    let dialog, sponsorId, otherSponsor;
    const sponsorName = "Booth fixture sponsor";
    const record = () =>
      page.locator(".complete-record").filter({
        has: page.getByRole("heading", { name: sponsorName, exact: true }),
      });
    const section = (kind) =>
      dialog.locator(".attachment-section").filter({
        has: page.getByRole("heading", { name: labels[kind], exact: true }),
      });
    const choose = async (kind, files, keyboard = false) => {
      const control = dialog.getByRole("button", {
        name:
          kind === "booth-location"
            ? "Choose booth location attachments"
            : "Choose booth design attachments",
        exact: true,
      });
      assert.equal(await control.isEnabled(), true);
      const chooser = page.waitForEvent("filechooser");
      if (keyboard) {
        await control.focus();
        await control.press("Enter");
      } else await control.click();
      const picker = await chooser;
      assert.equal(picker.isMultiple(), true);
      await picker.setFiles(files);
      await section(kind).getByText(files[0].name, { exact: true }).waitFor();
    };
    const save = async (create = false) => {
      await dialog
        .getByRole("button", {
          name: create ? "Create Sponsor" : "Save Changes",
          exact: true,
        })
        .click();
      await dialog
        .getByRole("button", { name: "Save Changes", exact: true })
        .waitFor();
      await dialog.locator(".pending-attachment").first().waitFor({
        state: "hidden",
      });
      await dialog.getByRole("alert").waitFor({ state: "hidden" });
    };
    const open = async () => {
      await record()
        .getByRole("button", { name: "Edit Sponsor", exact: true })
        .click();
      dialog = page.getByRole("dialog").last();
      await dialog
        .getByRole("tab", { name: "Booth Details", exact: true })
        .click();
    };
    const close = () =>
      dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const financeAndStatuses = (sponsor) => ({
      approval: sponsor.approval,
      approvalDate: sponsor.approvalDate,
      poIssued: sponsor.poIssued,
      poNumber: sponsor.poNumber,
      poDate: sponsor.poDate,
      value: sponsor.value,
      payments: sponsor.payments,
      received: sponsor.received,
      outstanding: sponsor.outstanding,
    });
    let initialFinancials;

    await t.test(
      "The new-sponsor choosers stage both file sections and save their correct owner without creating a blank record",
      async () => {
        await page
          .getByRole("button", { name: "Add Sponsor", exact: true })
          .first()
          .click();
        dialog = page.getByRole("dialog").last();
        await dialog
          .getByRole("tab", { name: "Booth Details", exact: true })
          .click();
        await dialog.getByLabel("Booth Size", { exact: true }).fill("4 × 3 m");
        await dialog
          .getByLabel("Booth Location", { exact: true })
          .fill("Hall B · Booth 12");
        await choose("booth-location", locationFiles, true);
        await choose("booth-design", designFiles);
        assert.equal(await dialog.locator(".pending-attachment").count(), 4);
        assert.equal(mutations.length, 0);
        assert.equal((await request("/sponsors")).length, 0);
        await dialog
          .getByRole("tab", { name: "Overview", exact: true })
          .click();
        await dialog
          .getByLabel("Sponsor Name", { exact: true })
          .fill(sponsorName);
        await dialog
          .getByLabel("Approval Status", { exact: true })
          .selectOption("Approved");
        await dialog
          .getByLabel("Approval Date", { exact: true })
          .fill("2026-10-07");
        await dialog
          .getByLabel("Purchase Order Issued", { exact: true })
          .selectOption("yes");
        await dialog
          .getByLabel("Purchase Order Number", { exact: true })
          .fill("BOOTH-FIXTURE-PO");
        await dialog
          .getByLabel("Purchase Order Date", { exact: true })
          .fill("2026-10-07");
        await dialog
          .getByRole("tab", { name: "Financials", exact: true })
          .click();
        await dialog
          .getByLabel("Total Sponsorship Value", { exact: true })
          .fill("1000");
        await dialog.getByLabel("Payment Amount", { exact: true }).fill("200");
        await dialog
          .getByLabel("Payment Date", { exact: true })
          .fill("2026-10-07");
        await dialog
          .getByRole("button", { name: "Add Payment", exact: true })
          .click();
        await dialog
          .getByRole("tab", { name: "Booth Details", exact: true })
          .click();
        await save(true);
        const sponsors = await request("/sponsors");
        assert.equal(sponsors.length, 1);
        const sponsor = sponsors[0];
        sponsorId = sponsor.id;
        initialFinancials = financeAndStatuses(sponsor);
        assert.equal(sponsor.boothSize, "4 × 3 m");
        assert.equal(sponsor.boothLocation, "Hall B · Booth 12");
        assert.equal(sponsor.attachments.length, 4);
        for (const [kind, files] of [
          ["booth-location", locationFiles],
          ["booth-design", designFiles],
        ]) {
          const saved = sponsor.attachments.filter(
            (attachment) => attachment.kind === kind,
          );
          assert.deepEqual(
            saved.map((file) => file.name).sort(),
            files.map((file) => file.name).sort(),
          );
          for (const file of files) {
            const attachment = saved.find(
              (savedFile) => savedFile.name === file.name,
            );
            assert.equal(attachment.sponsorId, sponsorId);
            const downloaded = await context.request.get(
              base + "/api/attachments/" + attachment.id,
            );
            assert.equal(downloaded.ok(), true);
            assert.deepEqual(await downloaded.body(), file.buffer);
          }
        }
        await close();
        await page.reload();
        await record().waitFor();
        const displayed = await record().innerText();
        assert.match(displayed, /Booth Size/);
        assert.match(displayed, /4 × 3 m/);
        assert.match(displayed, /Booth Location/);
        assert.match(displayed, /Hall B · Booth 12/);
        assert.match(displayed, /Booth Design/);
        for (const file of [...locationFiles, ...designFiles])
          assert.equal(
            await record()
              .getByRole("link", { name: "Download " + file.name, exact: true })
              .count(),
            1,
          );
        for (const file of [locationFiles[0], designFiles[0]]) {
          const image = record().getByRole("img", {
            name: file.name,
            exact: true,
          });
          await image.waitFor();
          await page.waitForFunction(
            (name) =>
              Array.from(document.images).some(
                (img) => img.alt === name && img.naturalWidth > 0,
              ),
            file.name,
          );
        }
        await open();
        assert.equal(
          await dialog.getByLabel("Booth Size", { exact: true }).inputValue(),
          "4 × 3 m",
        );
        assert.equal(
          await dialog
            .getByLabel("Booth Location", { exact: true })
            .inputValue(),
          "Hall B · Booth 12",
        );
        assert.equal(
          await section("booth-location").locator(".attachment-card").count(),
          2,
        );
        assert.equal(
          await section("booth-design").locator(".attachment-card").count(),
          2,
        );
      },
    );

    await t.test(
      "Dirty booth edits survive a failed design batch and retry preserves successful files and unrelated statuses/payments",
      async () => {
        await dialog.getByLabel("Booth Size", { exact: true }).fill("6 × 4 m");
        await dialog
          .getByLabel("Booth Location", { exact: true })
          .fill("Hall C · Booth 28");
        const location = {
          name: "updated-booth-map.png",
          mimeType: "image/png",
          buffer: png,
        };
        const design = {
          name: "updated-booth-design.pdf",
          mimeType: "application/pdf",
          buffer: pdf,
        };
        await choose("booth-location", [location]);
        await choose("booth-design", [design]);
        assert.equal(
          (await request("/sponsors/" + sponsorId)).boothSize,
          "4 × 3 m",
        );
        const uploadUrl = base + "/api/sponsors/" + sponsorId + "/attachments";
        await page.route(uploadUrl, async (route) => {
          if (
            route
              .request()
              .postDataBuffer()
              ?.toString()
              .includes('name="kind"\r\n\r\nbooth-design')
          )
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                error: "Temporary booth design upload failure.",
              }),
            });
          else await route.continue();
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
        assert.equal(
          await section("booth-location")
            .locator(".pending-attachment")
            .count(),
          0,
        );
        assert.equal(
          await section("booth-design").locator(".pending-attachment").count(),
          1,
        );
        const partial = await request("/sponsors/" + sponsorId);
        assert.equal(partial.boothSize, "6 × 4 m");
        assert.equal(partial.boothLocation, "Hall C · Booth 28");
        assert.equal(partial.attachments.length, 5);
        assert.deepEqual(financeAndStatuses(partial), initialFinancials);
        const mapId = partial.attachments.find(
          (file) => file.name === location.name,
        ).id;
        await page.unroute(uploadUrl);
        await save();
        const saved = await request("/sponsors/" + sponsorId);
        assert.equal(saved.attachments.length, 6);
        assert.equal(
          saved.attachments.filter((file) => file.name === location.name)
            .length,
          1,
        );
        assert.equal(
          saved.attachments.find((file) => file.name === location.name).id,
          mapId,
        );
        assert.equal(
          saved.attachments.filter((file) => file.name === design.name).length,
          1,
        );
        assert.deepEqual(financeAndStatuses(saved), initialFinancials);
        assert.equal(
          mutations.filter(
            (request) =>
              request.url === base + "/api/sponsors" &&
              request.method === "POST",
          ).length,
          1,
        );
      },
    );

    await t.test(
      "Replacement keeps the booth section/owner and deletion requires confirmation without affecting another sponsor",
      async () => {
        otherSponsor = await request("/sponsors", "POST", {
          name: "Other booth fixture sponsor",
          packageId: "",
          contact: "",
          mobile: "",
          email: "",
          approval: "Not Approved",
          approvalDate: "",
          poIssued: false,
          poNumber: "",
          poDate: "",
          value: 0,
          payments: [],
          benefits: [],
          notes: "",
          boothSize: "2 × 2 m",
          boothLocation: "Hall A · Booth 3",
        });
        const before = await request("/sponsors/" + sponsorId);
        const map = before.attachments.find(
          (file) => file.name === "booth-map.png",
        );
        const replacement = {
          name: "replaced-booth-map.png",
          mimeType: "image/png",
          buffer: png,
        };
        const chooser = page.waitForEvent("filechooser");
        await dialog
          .getByRole("button", { name: "Replace " + map.name, exact: true })
          .click();
        await (await chooser).setFiles(replacement);
        await section("booth-location")
          .locator(".attachment-info strong")
          .filter({ hasText: replacement.name })
          .waitFor();
        const afterReplacement = await request("/sponsors/" + sponsorId);
        const replaced = afterReplacement.attachments.find(
          (file) => file.id === map.id,
        );
        assert.equal(replaced.name, replacement.name);
        assert.equal(replaced.kind, "booth-location");
        assert.equal(replaced.sponsorId, sponsorId);
        assert.equal(
          afterReplacement.attachments.length,
          before.attachments.length,
        );
        const removed = before.attachments.find(
          (file) => file.name === "booth-design.pdf",
        );
        const dismiss = page.waitForEvent("dialog");
        const clickDismiss = dialog
          .getByRole("button", { name: "Delete " + removed.name, exact: true })
          .click();
        const dismissed = await dismiss;
        assert.match(
          dismissed.message(),
          /permanently removes the attachment/i,
        );
        await dismissed.dismiss();
        await clickDismiss;
        assert.equal(
          (await request("/sponsors/" + sponsorId)).attachments.some(
            (file) => file.id === removed.id,
          ),
          true,
        );
        const accept = page.waitForEvent("dialog");
        const clickAccept = dialog
          .getByRole("button", { name: "Delete " + removed.name, exact: true })
          .click();
        await (await accept).accept();
        await clickAccept;
        await section("booth-design")
          .getByText(removed.name, { exact: true })
          .waitFor({ state: "hidden" });
        const saved = await request("/sponsors/" + sponsorId);
        assert.equal(saved.attachments.length, 5);
        assert.equal(
          saved.attachments.some((file) => file.id === removed.id),
          false,
        );
        assert.deepEqual(financeAndStatuses(saved), initialFinancials);
        assert.deepEqual(
          await request("/sponsors/" + otherSponsor.id),
          otherSponsor,
        );
        await close();
        await page.reload();
        await record().waitFor();
        assert.equal(
          await record()
            .getByRole("link", {
              name: "Download " + replacement.name,
              exact: true,
            })
            .count(),
          1,
        );
      },
    );

    await t.test(
      "Viewers see booth images, previews and downloads but cannot change dimensions or files",
      async () => {
        const viewerContext = await browser.newContext({
          viewport: { width: 1280, height: 1000 },
        });
        try {
          const login = await viewerContext.request.post(base + "/api/login", {
            headers: { "X-Requested-With": "Maestro" },
            data: {
              email: "booth-viewer@example.test",
              password: viewerPassword,
            },
          });
          assert.equal(login.ok(), true);
          const viewer = await viewerContext.newPage();
          viewer.setDefaultTimeout(10000);
          viewer.on("pageerror", (error) => errors.push(error.message));
          await viewer.goto(base);
          const viewedRecord = viewer
            .locator(".complete-record")
            .filter({
              has: viewer.getByRole("heading", {
                name: sponsorName,
                exact: true,
              }),
            });
          await viewedRecord.waitFor();
          const previewImage = viewedRecord.getByRole("img", {
            name: "replaced-booth-map.png",
            exact: true,
          });
          await previewImage.waitFor();
          await viewer.waitForFunction(() =>
            Array.from(document.images).some(
              (img) =>
                img.alt === "replaced-booth-map.png" && img.naturalWidth > 0,
            ),
          );
          const download = viewedRecord.getByRole("link", {
            name: "Download replaced-booth-map.png",
            exact: true,
          });
          const downloadResponse = await viewerContext.request.get(
            base + (await download.getAttribute("href")),
          );
          assert.equal(downloadResponse.ok(), true);
          assert.deepEqual(await downloadResponse.body(), png);
          await viewedRecord
            .getByRole("button", { name: "View Sponsor", exact: true })
            .click();
          const viewedDialog = viewer.getByRole("dialog").last();
          await viewedDialog
            .getByRole("tab", { name: "Booth Details", exact: true })
            .click();
          for (const [label, expected] of [
            ["Booth Size", "6 × 4 m"],
            ["Booth Location", "Hall C · Booth 28"],
          ]) {
            assert.equal(
              await viewedDialog
                .getByLabel(label, { exact: true })
                .inputValue(),
              expected,
            );
            assert.equal(
              await viewedDialog
                .getByLabel(label, { exact: true })
                .isDisabled(),
              true,
            );
          }
          assert.equal(
            await viewedDialog.locator(".attachment-card").count(),
            5,
          );
          assert.equal(
            await viewedDialog
              .getByRole("button", {
                name: /Choose booth|Replace |Delete |Save Changes/,
              })
              .count(),
            0,
          );
          assert.equal(
            await viewedDialog
              .getByLabel(/Upload booth .* attachments/)
              .count(),
            0,
          );
          await viewedDialog
            .getByRole("button", {
              name: "Preview replaced-booth-map.png",
              exact: true,
            })
            .first()
            .click();
          const preview = viewer.getByRole("dialog", {
            name: "Preview replaced-booth-map.png",
            exact: true,
          });
          await preview
            .getByRole("img", { name: "replaced-booth-map.png", exact: true })
            .waitFor();
          await preview
            .getByRole("button", { name: "Zoom in", exact: true })
            .click();
          assert.match(
            await preview.locator(".preview-toolbar").innerText(),
            /125%/,
          );
          await preview
            .getByRole("button", { name: "Close preview", exact: true })
            .click();
          await viewedDialog
            .getByRole("button", {
              name: "Preview updated-booth-design.pdf",
              exact: true,
            })
            .first()
            .click();
          const pdfPreview = viewer.getByRole("dialog", {
            name: "Preview updated-booth-design.pdf",
            exact: true,
          });
          assert.equal(
            await pdfPreview
              .locator('iframe[title="updated-booth-design.pdf"]')
              .count(),
            1,
          );
          await pdfPreview
            .getByRole("button", { name: "Close preview", exact: true })
            .click();
          const forbidden = await viewerContext.request.post(
            base + "/api/sponsors/" + sponsorId + "/attachments",
            {
              headers: { "X-Requested-With": "Maestro" },
              multipart: {
                kind: "booth-design",
                files: {
                  name: "viewer-booth.png",
                  mimeType: "image/png",
                  buffer: png,
                },
              },
            },
          );
          assert.equal(forbidden.status(), 403);
        } finally {
          await viewerContext.close();
        }
      },
    );

    await t.test(
      "Long booth dimensions, location and attachment names remain usable at tablet/mobile widths",
      async () => {
        await open();
        await dialog
          .getByLabel("Booth Size", { exact: true })
          .fill("Width 6 m × Depth 4 m × Height 3.5 m");
        await dialog
          .getByLabel("Booth Location", { exact: true })
          .fill(
            "Hall C, Booth 28, beside the main entrance opposite the conference registration desk",
          );
        await save();
        for (const width of [834, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
            "Page overflow at " + width,
          );
          assert.equal(
            await dialog.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
            true,
            "Booth dialog overflow at " + width,
          );
          for (const label of ["Booth Size", "Booth Location"])
            assert.equal(
              await dialog.getByLabel(label, { exact: true }).isVisible(),
              true,
            );
        }
        await close();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        const finalSponsor = await request("/sponsors/" + sponsorId);
        assert.deepEqual(financeAndStatuses(finalSponsor), initialFinancials);
        assert.equal(finalSponsor.attachments.length, 5);
        assert.equal(await page.locator("html").getAttribute("dir"), "ltr");
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
