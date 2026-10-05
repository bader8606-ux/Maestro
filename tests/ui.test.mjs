import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

await test("English LTR dashboard works on desktop, tablet and mobile", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "maestro-ui-"));
  const server = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, DATA_DIR: dir, PORT: "0", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  const errors = [];
  try {
    const base = await new Promise((resolve, reject) => {
      let log = "";
      const timer = setTimeout(
        () => reject(new Error("Server startup timed out.")),
        30000,
      );
      server.stdout.on("data", (d) => {
        log += d;
        const m = log.match(/listening on port (\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve("http://127.0.0.1:" + m[1]);
        }
      });
      server.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Server exited before startup."));
      });
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page
      .getByRole("heading", { name: "Set up your workspace" })
      .waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    assert.equal(await page.locator("html").getAttribute("dir"), "ltr");
    await page
      .getByLabel(/Setup Token/)
      .fill(readFileSync(path.join(dir, "setup-token"), "utf8"));
    await page
      .getByLabel("Full Name", { exact: true })
      .fill("UI Administrator");
    await page
      .getByLabel("Email Address", { exact: true })
      .fill("ui@example.test");
    await page.getByLabel(/Password/).fill(randomBytes(24).toString("hex"));
    await page
      .getByRole("button", { name: "Create Administrator Account" })
      .click();
    await page
      .getByRole("heading", { name: "Digital Government Forum", exact: true })
      .waitFor();
    await page
      .getByRole("heading", { name: "Your next partnership starts here" })
      .waitFor();
    assert.equal(await page.locator("tbody tr").count(), 0);
    await page.screenshot({ path: "/tmp/maestro-desktop.png", fullPage: true });
    await page
      .getByRole("button", { name: "Sponsorship Packages", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add Package", exact: true })
      .first()
      .click();
    let dialog = page.getByRole("dialog").last();
    await dialog.getByLabel("Package Name").fill("UI test package");
    await dialog
      .getByRole("textbox", { name: "New default benefit" })
      .fill("UI test benefit");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.getByRole("button", { name: "Save Package" }).click();
    await page.getByRole("heading", { name: "UI test package" }).waitFor();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add Sponsor", exact: true })
      .first()
      .click();
    dialog = page.getByRole("dialog").last();
    await dialog
      .getByLabel("Sponsor Name", { exact: true })
      .fill("UI test sponsor");
    await dialog
      .getByLabel(/Sponsorship Package/)
      .selectOption({ label: "UI test package" });
    await dialog
      .getByLabel("Approval Status", { exact: true })
      .selectOption("Approved");
    await dialog.getByRole("tab", { name: "Contact Details" }).click();
    await dialog
      .getByLabel("Contact Person", { exact: true })
      .fill("UI test contact");
    await dialog.getByLabel(/Mobile Number/).fill("+966501234567");
    await dialog
      .getByLabel("Email Address", { exact: true })
      .fill("contact@example.test");
    assert.equal(
      await dialog
        .getByRole("link", { name: /Open WhatsApp/ })
        .getAttribute("href"),
      "https://wa.me/966501234567",
    );
    assert.equal(
      await dialog
        .getByRole("link", { name: "Call", exact: true })
        .getAttribute("href"),
      "tel:+966501234567",
    );
    await dialog.getByRole("tab", { name: "Financials" }).click();
    await dialog
      .getByLabel("Total Sponsorship Value", { exact: true })
      .fill("10000");
    await dialog.getByLabel("Payment Amount", { exact: true }).fill("1500.25");
    await dialog.getByLabel("Payment Date", { exact: true }).fill("2026-10-05");
    await dialog
      .getByRole("button", { name: "Add Payment", exact: true })
      .click();
    assert.match(
      await dialog.locator(".financial-cards").innerText(),
      /8,499\.75/,
    );
    await dialog
      .getByRole("button", { name: "Edit payment", exact: true })
      .click();
    await dialog.getByLabel("Payment Amount", { exact: true }).fill("1000.25");
    await dialog
      .getByRole("button", { name: "Save Payment", exact: true })
      .click();
    assert.match(
      await dialog.locator(".financial-cards").innerText(),
      /8,999\.75/,
    );
    await dialog
      .getByRole("button", { name: "Edit payment", exact: true })
      .click();
    await dialog.getByLabel("Payment Amount", { exact: true }).fill("1500.25");
    await dialog
      .getByRole("button", { name: "Save Payment", exact: true })
      .click();
    await dialog.getByRole("tab", { name: "Package Benefits" }).click();
    await dialog
      .getByRole("checkbox", { name: "Mark UI test benefit complete" })
      .check();
    await dialog
      .getByRole("button", { name: "Create Sponsor", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Save Changes", exact: true })
      .waitFor();
    await page
      .getByRole("status")
      .filter({ hasText: "Sponsor created successfully." })
      .waitFor();
    await dialog.getByRole("tab", { name: "Attachments" }).click();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
      "base64",
    );
    await dialog
      .getByLabel("Upload approval attachments", { exact: true })
      .setInputFiles({
        name: "ui-approval.png",
        mimeType: "image/png",
        buffer: png,
      });
    await dialog
      .locator(".attachment-info strong")
      .filter({ hasText: "ui-approval.png" })
      .waitFor();
    const pdf = await context.request.get(base + "/api/export/pdf");
    assert.ok(pdf.ok());
    await dialog
      .getByLabel("Upload purchase order attachments", { exact: true })
      .setInputFiles({
        name: "ui-order.pdf",
        mimeType: "application/pdf",
        buffer: await pdf.body(),
      });
    await dialog
      .locator(".attachment-info strong")
      .filter({ hasText: "ui-order.pdf" })
      .waitFor();
    await dialog
      .getByRole("button", { name: "Preview ui-approval.png", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    assert.match(await page.locator(".preview-toolbar").innerText(), /125%/);
    await page.getByRole("button", { name: "Close preview" }).click();
    await dialog
      .getByLabel("Replace ui-approval.png", { exact: true })
      .setInputFiles({
        name: "ui-replaced.png",
        mimeType: "image/png",
        buffer: png,
      });
    await dialog
      .locator(".attachment-info strong")
      .filter({ hasText: "ui-replaced.png" })
      .waitFor();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: /UI test sponsor UI test contact/ })
      .waitFor();
    await page
      .getByRole("textbox", { name: "Search sponsors" })
      .fill("no-match");
    await page.getByRole("heading", { name: "No matching sponsors" }).waitFor();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByLabel("Filter by approval status").selectOption("Approved");
    assert.equal(await page.locator("tbody tr").count(), 1);
    await page.getByLabel("Filter by purchase order").selectOption("yes");
    await page.getByRole("heading", { name: "No matching sponsors" }).waitFor();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.locator(".export-menu summary").click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export to Excel" }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "MAESTRO-Sponsors.xlsx");
    assert.match(
      await page.locator(".complete-records").innerText(),
      /UI test contact/,
    );
    assert.match(
      await page.locator(".complete-records").innerText(),
      /1,500\.25/,
    );
    assert.match(
      await page.locator(".complete-records").innerText(),
      /ui-order\.pdf/,
    );
    await page.reload();
    await page
      .getByRole("button", { name: /UI test sponsor UI test contact/ })
      .waitFor();
    await page
      .getByRole("button", { name: /UI test sponsor UI test contact/ })
      .click();
    dialog = page.getByRole("dialog").last();
    await dialog.getByRole("tab", { name: "Financials" }).click();
    assert.match(
      await dialog.locator(".financial-cards").innerText(),
      /1,500\.25/,
    );
    await dialog.getByRole("tab", { name: "Attachments" }).click();
    assert.equal(await dialog.locator(".attachment-card").count(), 2);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    for (const width of [834, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const overflow = await page.evaluate(() =>
        Array.from(document.querySelectorAll("*"))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.right > window.innerWidth + 1 && !el.closest(".table-scroll")
            );
          })
          .map((el) => ({
            tag: el.tagName,
            cls: el.className,
            right: el.getBoundingClientRect().right,
          }))
          .slice(0, 15),
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
        JSON.stringify({
          width,
          overflow,
          metrics: await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
            x: scrollX,
            viewport: innerWidth,
            html: getComputedStyle(document.documentElement).overflowX,
          })),
        }),
      );
      if (width === 390) {
        await page
          .getByRole("button", { name: "Sponsorship Packages", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Sponsorship Packages", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
      }
      await page.screenshot({
        path: "/tmp/maestro-" + width + ".png",
        fullPage: true,
      });
    }
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
