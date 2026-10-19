import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
  "base64",
);

for (const kind of ["quotation", "contract"]) {
  const heading =
    kind === "quotation" ? "Quotation Attachments" : "Contract Attachments";
  await test(`${heading} stage, preview, persist and retain their own section without changing sponsor commitments`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-quotation-ui-"));
    let browser;
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
    try {
      const base = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error("Quotation test server did not start.")),
          30000,
        );
        server.stdout.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/listening on port (\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve("http://127.0.0.1:" + match[1]);
          }
        });
        server.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Quotation test server exited before startup."));
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
        assert.equal(response.ok(), true, "Fixture request failed: " + url);
        return response.json();
      };
      await request("/setup", "POST", {
        token: await readFile(join(dir, "setup-token"), "utf8"),
        name: "Quotation administrator",
        email: "quotation-admin@example.test",
        password: randomBytes(24).toString("hex"),
      });
      const viewerPassword = randomBytes(24).toString("hex");
      await request("/users", "POST", {
        name: "Quotation viewer",
        email: "quotation-viewer@example.test",
        password: viewerPassword,
        role: "viewer",
      });
      const pdfResponse = await context.request.get(base + "/api/export/pdf");
      assert.equal(pdfResponse.ok(), true);
      const pdf = await pdfResponse.body();
      const files = [
        { name: "quotation.pdf", mimeType: "application/pdf", buffer: pdf },
        { name: "quotation-page.png", mimeType: "image/png", buffer: png },
      ];
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(10000);
      await page.goto(base);
      await page
        .getByRole("button", { name: "Add Sponsor", exact: true })
        .first()
        .click();
      let panel = page.getByRole("dialog").last();
      await panel
        .getByLabel("Sponsor Name", { exact: true })
        .fill("Quotation fixture sponsor");
      await panel
        .getByRole("tab", { name: "Attachments", exact: true })
        .click();
      const section = () =>
        panel.locator(".attachment-section").filter({
          has: page.getByRole("heading", {
            name: heading,
            exact: true,
          }),
        });
      let sponsor;
      await t.test(
        "The real file chooser stages multiple PDFs/images before sponsor creation and supports preview",
        async () => {
          const chooser = page.waitForEvent("filechooser");
          await panel
            .getByRole("button", {
              name: "Choose " + kind + " attachments",
              exact: true,
            })
            .click();
          const picker = await chooser;
          assert.equal(picker.isMultiple(), true);
          await picker.setFiles(files);
          await section().locator(".pending-attachment").last().waitFor();
          assert.equal(
            await section().locator(".pending-attachment").count(),
            2,
          );
          assert.equal((await request("/sponsors")).length, 0);
          await section()
            .getByRole("button", {
              name: "Preview selected quotation.pdf",
              exact: true,
            })
            .click();
          const preview = page.getByRole("dialog", {
            name: "Preview quotation.pdf",
            exact: true,
          });
          assert.match(
            await preview.locator("iframe").getAttribute("src"),
            /^blob:/,
          );
          await preview
            .getByRole("button", { name: "Close preview", exact: true })
            .click();
          await panel
            .getByRole("button", { name: "Create Sponsor", exact: true })
            .click();
          await section()
            .locator(".pending-attachment")
            .first()
            .waitFor({ state: "hidden" });
          sponsor = (await request("/sponsors"))[0];
          assert.equal(sponsor.attachments.length, 2);
          assert.equal(sponsor.approval, "Not Approved");
          assert.equal(sponsor.poIssued, false);
          assert.deepEqual(sponsor.payments, []);
          for (const file of files) {
            const saved = sponsor.attachments.find(
              (entry) => entry.name === file.name,
            );
            assert.equal(saved.kind, kind);
            assert.equal(saved.sponsorId, sponsor.id);
            const response = await context.request.get(
              base + "/api/attachments/" + saved.id + "?download=1",
            );
            assert.equal(response.status(), 200);
            assert.match(
              response.headers()["content-disposition"],
              /^attachment;/,
            );
            assert.deepEqual(await response.body(), file.buffer);
          }
        },
      );
      await t.test(
        "Saved documents appear only under their section in selected details; replacement preserves sponsor/section",
        async () => {
          await panel
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await page
            .getByRole("button", {
              name: "View Quotation fixture sponsor",
              exact: true,
            })
            .click();
          const record = page.locator(".complete-record");
          await record
            .getByRole("heading", { name: heading, exact: true })
            .waitFor();
          const quotation = record.locator("section").filter({
            has: page.getByRole("heading", {
              name: heading,
              exact: true,
            }),
          });
          assert.match(await quotation.innerText(), /quotation\.pdf/);
          const approval = record.locator("section").filter({
            has: page.getByRole("heading", {
              name: "Approval Attachments",
              exact: true,
            }),
          });
          assert.doesNotMatch(await approval.innerText(), /quotation\.pdf/);
          await quotation
            .getByRole("button", { name: "quotation-page.png", exact: true })
            .click();
          const preview = page.getByRole("dialog", {
            name: "Preview quotation-page.png",
            exact: true,
          });
          await preview.locator("img").waitFor();
          await page.waitForFunction(
            () => document.querySelector(".preview-body img")?.naturalWidth > 0,
          );
          await preview
            .getByRole("button", { name: "Zoom in", exact: true })
            .click();
          assert.match(await preview.innerText(), /125%/);
          await preview
            .getByRole("button", { name: "Close preview", exact: true })
            .click();
          await record
            .getByRole("button", { name: "Edit Sponsor", exact: true })
            .click();
          panel = page.getByRole("dialog").last();
          await panel
            .getByRole("tab", { name: "Attachments", exact: true })
            .click();
          const chooser = page.waitForEvent("filechooser");
          await section()
            .getByRole("button", { name: "Replace quotation.pdf", exact: true })
            .click();
          await (
            await chooser
          ).setFiles({
            name: "quotation-revised.pdf",
            mimeType: "application/pdf",
            buffer: pdf,
          });
          await section()
            .getByText("quotation-revised.pdf", { exact: true })
            .waitFor();
          const after = await request("/sponsors/" + sponsor.id);
          const replaced = after.attachments.find(
            (entry) => entry.name === "quotation-revised.pdf",
          );
          assert.equal(
            replaced.id,
            sponsor.attachments.find((entry) => entry.name === "quotation.pdf")
              .id,
          );
          assert.equal(replaced.sponsorId, sponsor.id);
          assert.equal(replaced.kind, kind);
          for (const field of [
            "value",
            "approval",
            "poIssued",
            "payments",
            "benefits",
            "packageId",
          ])
            assert.deepEqual(after[field], sponsor[field]);
        },
      );
      await t.test(
        "Deleting a document requires confirmation and leaves other files and statuses intact",
        async () => {
          page.once("dialog", (dialog) => dialog.dismiss());
          await section()
            .getByRole("button", {
              name: "Delete quotation-page.png",
              exact: true,
            })
            .click();
          assert.equal(
            (await request("/sponsors/" + sponsor.id)).attachments.length,
            2,
          );
          page.once("dialog", (dialog) => dialog.accept());
          await section()
            .getByRole("button", {
              name: "Delete quotation-page.png",
              exact: true,
            })
            .click();
          await section()
            .getByText("quotation-page.png", { exact: true })
            .waitFor({ state: "hidden" });
          const after = await request("/sponsors/" + sponsor.id);
          assert.equal(after.attachments.length, 1);
          assert.equal(after.attachments[0].kind, kind);
          assert.equal(after.approval, "Not Approved");
          assert.equal(after.poIssued, false);
          assert.deepEqual(after.payments, []);
        },
      );
      await t.test(
        "Viewers can preview documents but cannot upload or change them; anonymous reads require login",
        async () => {
          const viewerContext = await browser.newContext();
          const login = await viewerContext.request.post(base + "/api/login", {
            headers: { "X-Requested-With": "Maestro" },
            data: {
              email: "quotation-viewer@example.test",
              password: viewerPassword,
            },
          });
          assert.equal(login.ok(), true);
          const viewer = await viewerContext.newPage();
          await viewer.goto(base);
          await viewer
            .getByRole("button", {
              name: "View Quotation fixture sponsor",
              exact: true,
            })
            .click();
          await viewer
            .locator(".complete-record")
            .getByRole("button", { name: "View Sponsor", exact: true })
            .click();
          const viewerPanel = viewer.getByRole("dialog").last();
          await viewerPanel
            .getByRole("tab", { name: "Attachments", exact: true })
            .click();
          const viewerSection = viewerPanel
            .locator(".attachment-section")
            .filter({
              has: viewer.getByRole("heading", {
                name: heading,
                exact: true,
              }),
            });
          assert.equal(
            await viewerSection.locator(".attachment-card").count(),
            1,
          );
          assert.equal(
            await viewerSection
              .getByRole("button", { name: /Choose|Replace|Delete/ })
              .count(),
            0,
          );
          const attachment = (await request("/sponsors/" + sponsor.id))
            .attachments[0];
          assert.equal(
            (
              await viewerContext.request.get(
                base + "/api/attachments/" + attachment.id,
              )
            ).status(),
            200,
          );
          assert.equal(
            (
              await viewerContext.request.post(
                base + "/api/sponsors/" + sponsor.id + "/attachments",
                {
                  headers: { "X-Requested-With": "Maestro" },
                  multipart: {
                    kind,
                    files: {
                      name: "unauthorized.pdf",
                      mimeType: "application/pdf",
                      buffer: pdf,
                    },
                  },
                },
              )
            ).status(),
            403,
          );
          assert.equal(
            (
              await viewerContext.request.delete(
                base + "/api/attachments/" + attachment.id,
                { headers: { "X-Requested-With": "Maestro" } },
              )
            ).status(),
            403,
          );
          const anonymous = await browser.newContext();
          assert.equal(
            (
              await anonymous.request.get(
                base + "/api/attachments/" + attachment.id,
              )
            ).status(),
            401,
          );
          await anonymous.close();
          await viewerContext.close();
        },
      );
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      if (server.exitCode === null)
        await new Promise((resolve) => {
          server.once("exit", resolve);
          server.kill("SIGTERM");
        });
      await rm(dir, { recursive: true, force: true });
    }
  });
}
