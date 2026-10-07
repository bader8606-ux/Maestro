import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

const pairedName = "Mid Value Package";
const english = [
  "Brand visibility",
  "Speaking opportunity",
  "Meeting access",
  "Workshop participation",
  "Lanyard placement",
  "Exclusive final benefit for searching beyond the preview",
];
const arabic = [
  "ظهور العلامة",
  "",
  "الدخول للاجتماعات",
  "",
  "حضور ورشة العمل",
  "حصرية الموقع الأخير",
];
const longName = "Zulu Legacy Package " + "L".repeat(78);
const longBenefit = "Legacy commitment " + "C".repeat(280);

await test(
  "Sponsorship packages can be searched, compared and edited without changing stored content while browsing",
  { timeout: 180000 },
  async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "maestro-packages-display-"));
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
          () =>
            reject(new Error("Packages display fixture startup timed out.")),
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
        server.stderr.on("data", () => {});
        server.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("Packages display fixture exited before startup."));
        });
      });
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"],
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1080 },
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
        name: "Packages Display Fixture Administrator",
        email: "packages-display-admin@example.test",
        password: randomBytes(24).toString("hex"),
      });
      const viewerPassword = randomBytes(24).toString("hex");
      await request("/users", "POST", {
        name: "Packages Display Fixture Viewer",
        email: "packages-display-viewer@example.test",
        password: viewerPassword,
        role: "viewer",
      });
      const fixtures = [
        { name: longName, benefits: [longBenefit], benefitsAr: [] },
        {
          name: "Alpha Zero Package",
          referenceValue: 0,
          benefits: [],
          benefitsAr: [],
        },
        {
          name: pairedName,
          referenceValue: 750000,
          benefits: english,
          benefitsAr: arabic,
        },
        {
          name: "Prime Value Package",
          referenceValue: 2000000,
          benefits: ["Primary placement", "Meeting invitation"],
          benefitsAr: ["الموقع الرئيسي", "دعوة الاجتماع"],
        },
      ];
      const created = [];
      for (const fixture of fixtures)
        created.push(await request("/packages", "POST", fixture));
      const pairedId = created.find((p) => p.name === pairedName).id;
      const sponsor = await request("/sponsors", "POST", {
        name: "Packages Display Fixture Sponsor",
        packageId: pairedId,
        contact: "",
        mobile: "",
        email: "",
        approval: "Not Approved",
        approvalDate: "",
        poIssued: false,
        poNumber: "",
        poDate: "",
        value: 42.25,
        payments: [],
        benefits: [],
        notes: "Independent sponsor record for non-mutating display checks.",
      });
      const originalPackages = await request("/packages");
      const originalSponsor = await request("/sponsors/" + sponsor.id);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      const mutations = [];
      page.on("request", (req) => {
        if (
          ["POST", "PUT", "PATCH", "DELETE"].includes(req.method()) &&
          /\/api\/(packages|sponsors)(\/|$)/.test(req.url())
        )
          mutations.push(req.url());
      });
      await page.goto(base);
      await page
        .getByRole("heading", { name: "Digital Government Forum", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Sponsorship Packages", exact: true })
        .click();
      const catalogue = page.getByRole("dialog", {
        name: "Sponsorship Packages",
        exact: true,
      });
      await catalogue.getByLabel("Search packages", { exact: true }).waitFor();
      const card = (name) =>
        catalogue.locator(".package-card").filter({
          has: page.getByRole("heading", { name, exact: true }),
        });
      const names = () =>
        catalogue.locator(".package-card h2").allTextContents();
      const sections = (name, language) =>
        card(name)
          .locator(".package-benefit-language")
          .filter({
            has: page.getByRole("heading", {
              name: language + " Benefits",
              exact: true,
            }),
          });

      await t.test(
        "Reference comparison sorts real amounts including zero and leaves unspecified values last",
        async () => {
          assert.deepEqual(await names(), [
            "Alpha Zero Package",
            pairedName,
            "Prime Value Package",
            longName,
          ]);
          assert.match(await card("Alpha Zero Package").innerText(), /0\.00/);
          assert.match(await card(longName).innerText(), /Not provided/);
          await catalogue
            .getByLabel("Sort packages", { exact: true })
            .selectOption("value-asc");
          assert.deepEqual(await names(), [
            "Alpha Zero Package",
            pairedName,
            "Prime Value Package",
            longName,
          ]);
          await catalogue
            .getByLabel("Sort packages", { exact: true })
            .selectOption("value-desc");
          assert.deepEqual(await names(), [
            "Prime Value Package",
            pairedName,
            "Alpha Zero Package",
            longName,
          ]);
        },
      );

      await t.test(
        "Search includes names and hidden Arabic or English benefits and can recover from no results",
        async () => {
          const search = catalogue.getByLabel("Search packages", {
            exact: true,
          });
          await search.fill("pRiMe vAlUe");
          assert.deepEqual(await names(), ["Prime Value Package"]);
          await search.fill(arabic.at(-1));
          assert.deepEqual(await names(), [pairedName]);
          await search.fill(english.at(-1));
          assert.deepEqual(await names(), [pairedName]);
          await search.fill("missing fixture phrase");
          assert.deepEqual(await names(), []);
          await catalogue
            .locator(".package-search-empty")
            .getByRole("button", { name: "Clear search", exact: true })
            .click();
          assert.equal(await search.inputValue(), "");
          assert.equal((await names()).length, fixtures.length);
        },
      );

      await t.test(
        "Expanding bilingual benefits preserves their stored order and distinguishes missing Arabic translations",
        async () => {
          assert.deepEqual(
            await card(pairedName).locator("h3").allTextContents(),
            ["Arabic Benefits", "English Benefits"],
          );
          const expand = card(pairedName).getByRole("button", {
            name: "Show all benefits",
            exact: true,
          });
          assert.equal(await expand.getAttribute("aria-expanded"), "false");
          const previewCount = await sections(pairedName, "English")
            .locator(".package-benefit-row")
            .count();
          assert.equal(previewCount, 3);
          await expand.click();
          const collapse = card(pairedName).getByRole("button", {
            name: "Show fewer benefits",
            exact: true,
          });
          assert.equal(await collapse.getAttribute("aria-expanded"), "true");
          const controls = await collapse.getAttribute("aria-controls");
          assert.ok(controls);
          assert.equal(
            await page.locator('[id="' + controls + '"]').count(),
            1,
          );
          const enRows = sections(pairedName, "English").locator(
            ".package-benefit-row",
          );
          const arRows = sections(pairedName, "Arabic").locator(
            ".package-benefit-row",
          );
          assert.equal(await enRows.count(), english.length);
          assert.equal(await arRows.count(), english.length);
          for (let index = 0; index < english.length; index++) {
            assert.ok(
              (await enRows.nth(index).innerText()).includes(english[index]),
            );
            if (arabic[index]) {
              const translated = arRows
                .nth(index)
                .locator('.package-benefit-text[lang="ar"]');
              assert.equal(await translated.innerText(), arabic[index]);
              assert.equal(await translated.getAttribute("dir"), "rtl");
              assert.equal(
                await translated.evaluate(
                  (element) => getComputedStyle(element).direction,
                ),
                "rtl",
              );
            } else {
              assert.equal(
                await arRows.nth(index).locator('[lang="ar"]').count(),
                0,
              );
              const placeholder = arRows
                .nth(index)
                .locator('.package-benefit-copy[lang="en"][dir="ltr"]');
              assert.match(
                await placeholder.innerText(),
                /Arabic translation not provided/,
              );
            }
          }
          assert.equal(
            await card("Alpha Zero Package")
              .getByRole("button", { name: "Show all benefits", exact: true })
              .count(),
            0,
          );
          assert.match(
            await card("Alpha Zero Package").innerText(),
            /No default benefits/,
          );
          assert.ok((await card(longName).innerText()).includes(longBenefit));
          assert.equal(await card(longName).locator('[lang="ar"]').count(), 0);
          await catalogue.locator(".single-settings").evaluate((element) => {
            element.scrollTop = 0;
          });
          await page.screenshot({
            path: "/tmp/maestro-packages-desktop.png",
          });
          await collapse.click();
          assert.equal(
            await sections(pairedName, "English")
              .locator(".package-benefit-row")
              .count(),
            previewCount,
          );
          assert.equal(await expand.getAttribute("aria-expanded"), "false");
        },
      );

      await t.test(
        "Keyboard focus stays within the package editor and Escape returns to the open catalogue",
        async () => {
          const trigger = card(pairedName).getByRole("button", {
            name: "Edit Package",
            exact: true,
          });
          await trigger.click();
          const edit = page.getByRole("dialog", {
            name: "Edit Package",
            exact: true,
          });
          await edit.getByLabel("Package Name", { exact: true }).waitFor();
          const close = edit.getByRole("button", {
            name: "Close dialog",
            exact: true,
          });
          const save = edit.getByRole("button", {
            name: "Save Package",
            exact: true,
          });
          await close.focus();
          await page.keyboard.press("Shift+Tab");
          assert.equal(
            await save.evaluate(
              (element) => document.activeElement === element,
            ),
            true,
          );
          await page.keyboard.press("Tab");
          assert.equal(
            await close.evaluate(
              (element) => document.activeElement === element,
            ),
            true,
          );
          for (let index = 0; index < 12; index++) {
            await page.keyboard.press("Tab");
            assert.equal(
              await edit.evaluate((element) =>
                element.contains(document.activeElement),
              ),
              true,
            );
          }
          await page.keyboard.press("Escape");
          await edit.waitFor({ state: "hidden" });
          assert.equal(await catalogue.isVisible(), true);
          assert.equal(
            await trigger.evaluate(
              (element) => document.activeElement === element,
            ),
            true,
          );
        },
      );

      await t.test(
        "Browsing is read-only and package controls remain usable without horizontal overflow on phone and tablet",
        async () => {
          for (const width of [320, 390, 834]) {
            await page.setViewportSize({ width, height: 1080 });
            await card(pairedName)
              .getByRole("button", { name: "Show all benefits", exact: true })
              .click();
            assert.equal(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
              true,
              "The page overflowed at " + width + "px.",
            );
            assert.equal(
              await catalogue.evaluate(
                (element) => element.scrollWidth <= element.clientWidth,
              ),
              true,
              "The catalogue overflowed at " + width + "px.",
            );
            for (const control of [
              catalogue.getByLabel("Search packages", { exact: true }),
              catalogue.getByLabel("Sort packages", { exact: true }),
              card(pairedName).getByRole("button", {
                name: "Edit Package",
                exact: true,
              }),
              card(pairedName).getByRole("button", {
                name: "Show fewer benefits",
                exact: true,
              }),
            ]) {
              await control.scrollIntoViewIfNeeded();
              const box = await control.boundingBox();
              assert.ok(
                box && box.x >= 0 && box.x + box.width <= width + 1,
                "A package control is off-screen at " + width + "px.",
              );
            }
            if (width === 320 || width === 390) {
              await catalogue
                .getByLabel("Search packages", { exact: true })
                .fill(pairedName);
              await catalogue
                .locator(".single-settings")
                .evaluate((element) => {
                  element.scrollTop = 0;
                });
              await page.screenshot({
                path:
                  width === 390
                    ? "/tmp/maestro-packages-mobile.png"
                    : "/tmp/maestro-packages-mobile-320.png",
              });
              await catalogue
                .getByRole("button", { name: "Clear search", exact: true })
                .click();
            }
            await card(pairedName)
              .getByRole("button", { name: "Show fewer benefits", exact: true })
              .click();
          }
          assert.deepEqual(mutations, []);
          assert.deepEqual(await request("/packages"), originalPackages);
          assert.deepEqual(
            await request("/sponsors/" + sponsor.id),
            originalSponsor,
          );
        },
      );

      await t.test(
        "Editing saves the reference value and paired benefit changes while existing sponsor data remains independent",
        async () => {
          await page.setViewportSize({ width: 390, height: 1080 });
          await card(pairedName)
            .getByRole("button", { name: "Edit Package", exact: true })
            .click();
          const edit = page.getByRole("dialog", {
            name: "Edit Package",
            exact: true,
          });
          await edit
            .getByLabel("Package Reference Value", { exact: true })
            .fill("777000.50");
          await edit
            .getByLabel("Default benefit 1", { exact: true })
            .fill("Updated visibility");
          await edit
            .getByLabel("Arabic default benefit 1", { exact: true })
            .fill("ظهور محدث");
          await edit
            .getByRole("button", {
              name: "Remove default benefit",
              exact: true,
            })
            .nth(1)
            .click();
          await edit
            .getByLabel("New default benefit", { exact: true })
            .fill("Additional final commitment");
          await edit
            .getByLabel("New Arabic default benefit", { exact: true })
            .fill("التزام أخير إضافي");
          await edit.getByRole("button", { name: "Add", exact: true }).click();
          assert.equal(
            await edit.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
            true,
          );
          await edit.evaluate((element) => {
            element.scrollTop = 0;
          });
          await page.screenshot({
            path: "/tmp/maestro-packages-editor-mobile.png",
          });
          const saved = page.waitForResponse(
            (res) =>
              res.url() === base + "/api/packages/" + pairedId &&
              res.request().method() === "PUT",
          );
          await edit
            .getByRole("button", { name: "Save Package", exact: true })
            .click();
          assert.equal((await saved).ok(), true);
          await edit.waitFor({ state: "hidden" });
          const expectedEnglish = [
            "Updated visibility",
            ...english.slice(2),
            "Additional final commitment",
          ];
          const expectedArabic = [
            "ظهور محدث",
            ...arabic.slice(2),
            "التزام أخير إضافي",
          ];
          const current = await request("/packages");
          const updated = current.find((p) => p.id === pairedId);
          assert.equal(updated.referenceValue, 777000.5);
          assert.deepEqual(updated.benefits, expectedEnglish);
          assert.deepEqual(updated.benefitsAr, expectedArabic);
          assert.deepEqual(
            current.filter((p) => p.id !== pairedId),
            originalPackages.filter((p) => p.id !== pairedId),
          );
          assert.deepEqual(
            await request("/sponsors/" + sponsor.id),
            originalSponsor,
          );
          assert.match(await card(pairedName).innerText(), /777,000\.50/);
          await catalogue
            .getByRole("button", { name: "Close dialog", exact: true })
            .click();
          await page.reload();
          await page
            .getByRole("button", { name: "Sponsorship Packages", exact: true })
            .click();
          await card(pairedName)
            .getByRole("button", { name: "Show all benefits", exact: true })
            .click();
          assert.ok(
            (await card(pairedName).innerText()).includes(
              expectedArabic.at(-1),
            ),
          );
          assert.ok(
            (await card(pairedName).innerText()).includes(
              expectedEnglish.at(-1),
            ),
          );
        },
      );

      await t.test(
        "Viewers can search and expand bilingual packages but cannot add, edit or delete them",
        async () => {
          const viewerContext = await browser.newContext({
            viewport: { width: 390, height: 1080 },
          });
          const viewerPage = await viewerContext.newPage();
          viewerPage.setDefaultTimeout(10000);
          viewerPage.on("pageerror", (error) => errors.push(error.message));
          await viewerPage.goto(base);
          await viewerPage
            .getByLabel("Email Address", { exact: true })
            .fill("packages-display-viewer@example.test");
          await viewerPage
            .getByLabel("Password", { exact: true })
            .fill(viewerPassword);
          await viewerPage
            .getByRole("button", { name: "Sign In", exact: true })
            .click();
          await viewerPage
            .getByRole("button", { name: "Sponsorship Packages", exact: true })
            .click();
          const viewerCatalogue = viewerPage.getByRole("dialog", {
            name: "Sponsorship Packages",
            exact: true,
          });
          await viewerCatalogue
            .getByLabel("Search packages", { exact: true })
            .fill(pairedName);
          assert.equal(
            await viewerCatalogue.locator(".package-card").count(),
            1,
          );
          assert.equal(
            await viewerCatalogue
              .getByRole("button", { name: "Add Package", exact: true })
              .count(),
            0,
          );
          assert.equal(
            await viewerCatalogue
              .getByRole("button", { name: "Edit Package", exact: true })
              .count(),
            0,
          );
          assert.equal(
            await viewerCatalogue
              .getByRole("button", { name: /^Delete / })
              .count(),
            0,
          );
          await viewerCatalogue
            .getByRole("button", { name: "Show all benefits", exact: true })
            .click();
          assert.ok(
            (await viewerCatalogue.innerText()).includes("التزام أخير إضافي"),
          );
          const read = await viewerContext.request.get(base + "/api/packages");
          assert.equal(read.ok(), true);
          assert.deepEqual(await read.json(), await request("/packages"));
          await viewerContext.close();
        },
      );
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      if (server.exitCode === null && server.signalCode === null) {
        await new Promise((resolve) => {
          const killTimer = setTimeout(() => server.kill("SIGKILL"), 5000);
          server.once("exit", () => {
            clearTimeout(killTimer);
            resolve();
          });
          server.kill("SIGTERM");
        });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
