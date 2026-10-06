import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

await test("English workspace persists paired Arabic benefits and undetermined sponsorship values", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "maestro-bilingual-ui-"));
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
  const english = [
    "Brand visibility",
    "Speaking opportunity",
    "Meeting access",
  ];
  const arabic = ["ظهور العلامة", "فرصة التحدث", "الدخول للاجتماعات"];
  const added = {
    english: "Workshop participation",
    arabic: "المشاركة في ورشة العمل",
  };
  const consideration = "Media support; scope pending confirmation.";
  try {
    const base = await new Promise((resolve, reject) => {
      let log = "";
      const timer = setTimeout(
        () => reject(new Error("Bilingual UI test server startup timed out.")),
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
        reject(new Error("Bilingual UI test server exited before startup."));
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
      name: "Bilingual Test Administrator",
      email: "bilingual-ui@example.test",
      password: randomBytes(24).toString("hex"),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page
      .getByRole("heading", { name: "Digital Government Forum", exact: true })
      .waitFor();
    let dialog, sponsorId, packageId, benefitIds;
    const record = () =>
      page
        .locator(".complete-record")
        .filter({
          has: page.getByRole("heading", {
            name: "Bilingual fixture sponsor",
            exact: true,
          }),
        });
    const openSponsor = async () => {
      await record()
        .getByRole("button", { name: "Edit Sponsor", exact: true })
        .click();
      dialog = page.getByRole("dialog").last();
      await dialog.getByLabel("Sponsor Name", { exact: true }).waitFor();
    };
    const checkArabicField = async (field) => {
      assert.equal(await field.getAttribute("lang"), "ar");
      assert.equal(await field.getAttribute("dir"), "rtl");
      assert.equal(
        await field.evaluate((element) => getComputedStyle(element).direction),
        "rtl",
      );
    };
    const saveSponsor = async (create = false) => {
      const response = page.waitForResponse(
        (res) =>
          res.request().method() === (create ? "POST" : "PUT") &&
          res.url() ===
            base + "/api/sponsors" + (create ? "" : "/" + sponsorId),
      );
      await dialog
        .getByRole("button", {
          name: create ? "Create Sponsor" : "Save Changes",
          exact: true,
        })
        .click();
      assert.equal((await response).ok(), true);
      await dialog
        .getByRole("button", { name: "Save Changes", exact: true })
        .waitFor();
    };

    await t.test(
      "Package editing preserves parallel English and Arabic defaults when removing and adding benefits",
      async () => {
        await page
          .getByRole("button", { name: "Sponsorship Packages", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Add Package", exact: true })
          .first()
          .click();
        dialog = page.getByRole("dialog").last();
        await dialog
          .getByLabel("Package Name", { exact: true })
          .fill("Bilingual fixture package");
        for (const [en, ar] of [
          ["Temporary default", "ميزة مؤقتة"],
          [english[0], arabic[0]],
          [english[1], arabic[1]],
        ]) {
          await dialog
            .getByLabel("New default benefit", { exact: true })
            .fill(en);
          const field = dialog.getByLabel("New Arabic default benefit", {
            exact: true,
          });
          await checkArabicField(field);
          await field.fill(ar);
          await dialog
            .getByRole("button", { name: "Add", exact: true })
            .click();
        }
        await dialog
          .getByRole("button", { name: "Save Package", exact: true })
          .click();
        const card = page
          .locator(".package-card")
          .filter({
            has: page.getByRole("heading", {
              name: "Bilingual fixture package",
              exact: true,
            }),
          });
        await card.waitFor();
        assert.deepEqual(await card.locator("h3").allTextContents(), [
          "Arabic Benefits",
          "English Benefits",
        ]);
        await card.getByRole("button", { name: "Edit", exact: true }).click();
        dialog = page.getByRole("dialog").last();
        await dialog
          .getByRole("button", { name: "Remove default benefit", exact: true })
          .first()
          .click();
        for (const index of [0, 1]) {
          assert.equal(
            await dialog
              .getByLabel("Default benefit " + (index + 1), { exact: true })
              .inputValue(),
            english[index],
          );
          const translated = dialog.getByLabel(
            "Arabic default benefit " + (index + 1),
            { exact: true },
          );
          assert.equal(await translated.inputValue(), arabic[index]);
          await checkArabicField(translated);
        }
        await dialog
          .getByLabel("New default benefit", { exact: true })
          .fill(english[2]);
        await dialog
          .getByLabel("New Arabic default benefit", { exact: true })
          .fill(arabic[2]);
        await dialog.getByRole("button", { name: "Add", exact: true }).click();
        await dialog
          .getByRole("button", { name: "Save Package", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Edit Package", exact: true })
          .waitFor({ state: "hidden" });
        const packages = await request("/packages");
        assert.equal(packages.length, 1);
        packageId = packages[0].id;
        assert.deepEqual(packages[0].benefits, english);
        assert.deepEqual(packages[0].benefitsAr, arabic);
        await page
          .getByRole("dialog", { name: "Sponsorship Packages", exact: true })
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
      },
    );

    await t.test(
      "A new sponsor copies translated benefits, shares completion and saves unknown consideration with payments",
      async () => {
        await page
          .getByRole("button", { name: "Add Sponsor", exact: true })
          .first()
          .click();
        dialog = page.getByRole("dialog").last();
        await dialog
          .getByLabel("Sponsor Name", { exact: true })
          .fill("Bilingual fixture sponsor");
        await dialog
          .getByLabel("Sponsorship Package", { exact: true })
          .selectOption(packageId);
        await dialog
          .getByRole("tab", { name: "Package Benefits", exact: true })
          .click();
        assert.deepEqual(
          await dialog
            .locator(".benefit-language-section h3")
            .allTextContents(),
          ["Arabic Benefits", "English Benefits"],
        );
        assert.deepEqual(
          await dialog
            .getByLabel("Benefit description", { exact: true })
            .evaluateAll((fields) => fields.map((field) => field.value)),
          english,
        );
        assert.deepEqual(
          await dialog
            .getByLabel("Arabic benefit description", { exact: true })
            .evaluateAll((fields) => fields.map((field) => field.value)),
          arabic,
        );
        await dialog
          .getByLabel("New benefit", { exact: true })
          .fill(added.english);
        const arabicNew = dialog.getByLabel("New Arabic benefit", {
          exact: true,
        });
        await checkArabicField(arabicNew);
        await arabicNew.fill(added.arabic);
        await dialog
          .getByRole("button", { name: "Add Benefit", exact: true })
          .click();
        await dialog
          .getByRole("checkbox", {
            name: "Mark Arabic translation for " + english[0] + " complete",
            exact: true,
          })
          .check();
        assert.equal(
          await dialog
            .getByRole("checkbox", {
              name: "Mark " + english[0] + " complete",
              exact: true,
            })
            .isChecked(),
          true,
        );
        assert.equal(
          await dialog.locator(".benefit-summary > span").innerText(),
          "1 of 4 completed",
        );
        assert.equal(
          await dialog
            .getByLabel("Benefit description", { exact: true })
            .count(),
          4,
        );
        assert.equal(
          await dialog
            .getByLabel("Arabic benefit description", { exact: true })
            .count(),
          4,
        );
        await dialog
          .getByRole("tab", { name: "Financials", exact: true })
          .click();
        const unknown = dialog.getByRole("checkbox", {
          name: "Sponsorship value not determined",
          exact: true,
        });
        const value = dialog.getByLabel("Total Sponsorship Value", {
          exact: true,
        });
        await unknown.check();
        assert.equal(await value.isDisabled(), true);
        assert.equal(await value.inputValue(), "");
        await unknown.uncheck();
        assert.equal(await value.isEnabled(), true);
        assert.equal(await value.inputValue(), "0");
        await unknown.check();
        await dialog
          .getByLabel("Sponsorship Consideration", { exact: true })
          .fill(consideration);
        await dialog.getByLabel("Payment Amount", { exact: true }).fill("25");
        await dialog
          .getByLabel("Payment Date", { exact: true })
          .fill("2026-10-06");
        await dialog
          .getByRole("button", { name: "Add Payment", exact: true })
          .click();
        assert.match(
          await dialog.locator(".financial-cards").innerText(),
          /25\.00/,
        );
        assert.match(
          await dialog.locator(".financial-cards").innerText(),
          /Not determined/,
        );
        await saveSponsor(true);
        const sponsors = await request("/sponsors");
        assert.equal(sponsors.length, 1);
        const saved = sponsors[0];
        sponsorId = saved.id;
        assert.equal(saved.value, null);
        assert.equal(saved.outstanding, null);
        assert.equal(saved.received, 25);
        assert.equal(saved.consideration, consideration);
        assert.equal(saved.benefits.length, 4);
        benefitIds = saved.benefits.map((benefit) => benefit.id);
        assert.equal(new Set(benefitIds).size, 4);
        assert.deepEqual(
          saved.benefits.map((benefit) => benefit.title),
          [...english, added.english],
        );
        assert.deepEqual(
          saved.benefits.map((benefit) => benefit.titleAr),
          [...arabic, added.arabic],
        );
        assert.deepEqual(
          saved.benefits.map((benefit) => benefit.completed),
          [true, false, false, false],
        );
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
      },
    );

    await t.test(
      "Dashboard separates actual receipts from balances when an in-kind amount is unknown",
      async () => {
        await page
          .getByRole("button", { name: "Add Sponsor", exact: true })
          .first()
          .click();
        dialog = page.getByRole("dialog").last();
        await dialog
          .getByLabel("Sponsor Name", { exact: true })
          .fill("Cash fixture sponsor");
        await dialog
          .getByRole("tab", { name: "Financials", exact: true })
          .click();
        await dialog
          .getByLabel("Total Sponsorship Value", { exact: true })
          .fill("100");
        await dialog.getByLabel("Payment Amount", { exact: true }).fill("10");
        await dialog
          .getByLabel("Payment Date", { exact: true })
          .fill("2026-10-06");
        await dialog
          .getByRole("button", { name: "Add Payment", exact: true })
          .click();
        await saveSponsor(true);
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await page.reload();
        await record().waitFor();
        const stat = (label) =>
          page
            .locator(".stat-card")
            .filter({ has: page.getByText(label, { exact: true }) })
            .locator(".stat-value");
        for (const [label, amount] of [
          ["Total Sponsorship Value", "100.00"],
          ["Total Received", "35.00"],
          ["Outstanding Balance", "90.00"],
        ]) {
          assert.equal(
            (await stat(label).innerText()).replace(/\s/g, ""),
            "SAR" + amount,
          );
        }
        assert.equal(
          await record().getByText("Not determined", { exact: true }).count(),
          2,
        );
        assert.equal(
          await record().getByText(consideration, { exact: true }).count(),
          1,
        );
        assert.deepEqual(
          await record().locator(".translated-benefits h3").allTextContents(),
          ["Arabic Benefits", "English Benefits"],
        );
        assert.deepEqual(
          await record()
            .locator('.translated-benefits [lang="ar"]')
            .allTextContents(),
          [...arabic, added.arabic],
        );
        assert.deepEqual(
          await record()
            .locator('.translated-benefits [lang="en"]')
            .allTextContents(),
          [...english, added.english],
        );
        assert.equal(await page.locator("html").getAttribute("lang"), "en");
        assert.equal(await page.locator("html").getAttribute("dir"), "ltr");
      },
    );

    await t.test(
      "Arabic translation edits preserve benefit IDs and the paired completion state on reload",
      async () => {
        await openSponsor();
        await dialog
          .getByRole("tab", { name: "Package Benefits", exact: true })
          .click();
        const edited = "فرصة تقديم جلسة حوارية";
        const translated = dialog
          .getByLabel("Arabic benefit description", { exact: true })
          .nth(1);
        await checkArabicField(translated);
        await translated.fill(edited);
        await dialog
          .getByRole("checkbox", {
            name: "Mark " + english[1] + " complete",
            exact: true,
          })
          .check();
        assert.equal(
          await dialog
            .getByRole("checkbox", {
              name: "Mark Arabic translation for " + english[1] + " complete",
              exact: true,
            })
            .isChecked(),
          true,
        );
        assert.equal(
          await dialog.locator(".benefit-summary > span").innerText(),
          "2 of 4 completed",
        );
        await saveSponsor();
        const saved = await request("/sponsors/" + sponsorId);
        assert.deepEqual(
          saved.benefits.map((benefit) => benefit.id),
          benefitIds,
        );
        assert.equal(saved.benefits[1].title, english[1]);
        assert.equal(saved.benefits[1].titleAr, edited);
        assert.equal(saved.benefits[1].completed, true);
        assert.equal(saved.value, null);
        assert.equal(saved.outstanding, null);
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await page.reload();
        await record().getByText(edited, { exact: true }).waitFor();
        await openSponsor();
        await dialog
          .getByRole("tab", { name: "Package Benefits", exact: true })
          .click();
        assert.equal(await translated.inputValue(), edited);
        assert.equal(
          await dialog.locator(".benefit-summary > span").innerText(),
          "2 of 4 completed",
        );
      },
    );

    await t.test(
      "Arabic descriptions retain RTL direction on a 390px English LTR page without overflow",
      async () => {
        await page.setViewportSize({ width: 390, height: 1000 });
        for (const field of await dialog
          .getByLabel("Arabic benefit description", { exact: true })
          .all())
          await checkArabicField(field);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        assert.equal(
          await dialog.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
          true,
        );
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        const directions = await record()
          .locator('.translated-benefits [lang="ar"]')
          .evaluateAll((elements) =>
            elements.map((element) => getComputedStyle(element).direction),
          );
        assert.deepEqual(directions, ["rtl", "rtl", "rtl", "rtl"]);
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
