import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import express from "express";
import { chromium } from "playwright-core";
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve("http://127.0.0.1:" + server.address().port),
    ),
  );
const close = (server) => new Promise((resolve) => server.close(resolve));
export async function cloudBrowser({
  config,
  admin,
  viewer,
  db,
  sponsorIds,
  startEdge,
}) {
  const dir = await mkdtemp(join(tmpdir(), "maestro-pages-test-"));
  const app = express();
  app.use("/Maestro", express.static(dir));
  const frontend = createServer(app);
  const proxy = createServer(async (req, res) => {
    try {
      const target = req.url.startsWith("/functions/v1/maestro-api")
        ? "http://127.0.0.1:8877" + req.url.replace("/functions/v1", "")
        : config.API_URL + req.url;
      const headers = { ...req.headers };
      delete headers.host;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = ["GET", "HEAD"].includes(req.method)
        ? undefined
        : Buffer.concat(chunks);
      const response = await fetch(target, {
        method: req.method,
        headers,
        body,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(502);
      res.end("The test proxy could not connect.");
    }
  });
  let browser, edge;
  try {
    const ui = await listen(frontend),
      cloud = await listen(proxy);
    await new Promise((resolve, reject) => {
      const build = spawn(
        process.execPath,
        [
          "node_modules/vite/bin/vite.js",
          "build",
          "--outDir",
          dir,
          "--emptyOutDir",
        ],
        {
          env: {
            ...process.env,
            VITE_SUPABASE_URL: cloud,
            VITE_SUPABASE_PUBLISHABLE_KEY: config.ANON_KEY,
            VITE_BASE_PATH: "/Maestro/",
            VITE_HOSTING: "pages",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      build.stdout.on("data", (d) => (output += d));
      build.stderr.on("data", (d) => (output += d));
      build.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Cloud frontend build failed: " + output)),
      );
    });
    edge = await startEdge(ui);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 1000 },
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ui + "/Maestro/");
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
    assert.equal(await page.getByLabel("Setup Token").count(), 0);
    await page.getByLabel("Email Address", { exact: true }).fill(admin.email);
    await page.getByLabel("Password", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await page
      .getByRole("heading", { name: "Digital Government Forum", exact: true })
      .waitFor();
    await page.waitForFunction(
      () => document.querySelector('img[alt="MAESTRO"]')?.naturalWidth > 0,
    );
    await page
      .getByRole("button", { name: "Add Sponsor", exact: true })
      .first()
      .click();
    let dialog = page.getByRole("dialog").last();
    await dialog
      .getByLabel("Sponsor Name", { exact: true })
      .fill("Cloud UI sponsor");
    await dialog
      .getByLabel("Approval Status", { exact: true })
      .selectOption("In Progress");
    await dialog
      .getByLabel("Purchase Order Issued", { exact: true })
      .selectOption("yes");
    await dialog.getByRole("tab", { name: "Financials", exact: true }).click();
    await dialog
      .getByLabel("Total Sponsorship Value", { exact: true })
      .fill("99.99");
    await dialog.getByLabel("Payment Amount", { exact: true }).fill("25.01");
    await dialog.getByLabel("Payment Date", { exact: true }).fill("2026-10-05");
    await dialog
      .getByRole("button", { name: "Add Payment", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Create Sponsor", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Save Changes", exact: true })
      .waitFor();
    const { data: rows, error } = await db
      .from("maestro_sponsors")
      .select("id")
      .eq("data->>name", "Cloud UI sponsor");
    assert.equal(error, null);
    assert.equal(rows.length, 1);
    sponsorIds.push(rows[0].id);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    let card = page
      .locator(".complete-record")
      .filter({
        has: page.getByRole("heading", {
          name: "Cloud UI sponsor",
          exact: true,
        }),
      });
    await card.waitFor();
    assert.match(await card.innerText(), /74\.98/);
    assert.equal(page.url(), ui + "/Maestro/");
    await page.reload();
    await card.waitFor();
    await card
      .getByRole("button", { name: "Edit Sponsor", exact: true })
      .click();
    dialog = page.getByRole("dialog").last();
    await dialog
      .getByLabel("Sponsor Name", { exact: true })
      .fill("Cloud UI updated");
    await dialog
      .getByRole("button", { name: "Save Changes", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Sponsor updated successfully." })
      .waitFor();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    card = page
      .locator(".complete-record")
      .filter({
        has: page.getByRole("heading", {
          name: "Cloud UI updated",
          exact: true,
        }),
      });
    await card.waitFor();
    assert.match(await card.innerText(), /25\.01/);
    await page
      .locator(".complete-record")
      .filter({
        has: page.getByRole("heading", {
          name: "Cloud test sponsor",
          exact: true,
        }),
      })
      .getByRole("button", { name: "replacement.png", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".preview-image img")?.naturalWidth > 0 ||
        document.querySelector(".preview-body img")?.naturalWidth > 0,
    );
    await page
      .getByRole("button", { name: "Close preview", exact: true })
      .click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
    await page.getByLabel("Email Address", { exact: true }).fill(viewer.email);
    await page.getByLabel("Password", { exact: true }).fill(viewer.password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await page
      .getByRole("heading", { name: "Cloud UI updated", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Add Sponsor", exact: true })
        .count(),
      0,
    );
    await page.locator(".export-menu summary").click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export to Excel", exact: true })
      .click();
    assert.equal((await download).suggestedFilename(), "MAESTRO-Sponsors.xlsx");
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (edge && edge.exitCode === null)
      await new Promise((resolve) => {
        edge.once("exit", resolve);
        edge.kill("SIGTERM");
      });
    await Promise.all([close(frontend), close(proxy)]);
    await rm(dir, { recursive: true, force: true });
  }
}
