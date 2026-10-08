import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

await test("Team & Access keeps every workspace member reachable on desktop, tablet and mobile", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "maestro-team-access-"));
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
  try {
    const base = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Team access fixture startup timed out.")),
        30000,
      );
      server.stdout.on("data", (data) => {
        output += data;
        const match = output.match(/listening on port (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve("http://127.0.0.1:" + match[1]);
        }
      });
      server.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Team access fixture exited before startup."));
      });
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const request = async (url, method = "GET", data, client = context) => {
      const response = await client.request.fetch(base + "/api" + url, {
        method,
        headers: { "X-Requested-With": "Maestro" },
        ...(data === undefined ? {} : { data }),
      });
      assert.equal(response.ok(), true, "Fixture request failed: " + url);
      return response.json();
    };
    const password = randomBytes(24).toString("hex");
    const administrator = await request("/setup", "POST", {
      token: readFileSync(path.join(dir, "setup-token"), "utf8"),
      name: "Access Fixture Administrator",
      email: "team-admin@example.test",
      password,
    });
    const members = [];
    for (let index = 1; index <= 25; index++) {
      const member = await request("/users", "POST", {
        name: "Team Fixture Member " + String(index).padStart(2, "0"),
        email: "team-member-" + index + "@example.test",
        password,
        role: ["viewer", "editor", "admin"][(index - 1) % 3],
      });
      if (index % 5 === 0)
        await request("/users/" + member.id, "PATCH", {
          role: member.role,
          active: false,
        });
      members.push(member);
    }
    const initial = await request("/users");
    assert.equal(initial.length, 26);
    assert.equal(initial.filter((member) => !member.active).length, 5);
    assert.deepEqual(
      new Set(initial.map((member) => member.id)),
      new Set([administrator.id, ...members.map((member) => member.id)]),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const openTeam = async (expectedCount = 26) => {
      await page
        .getByRole("button", { name: "Team & Access", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Team & Access",
        exact: true,
      });
      await dialog
        .getByRole("heading", { name: /Workspace Members/ })
        .waitFor();
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll(
            '[role="dialog"][aria-label="Team & Access"] tbody tr',
          ).length === count,
        expectedCount,
      );
      return dialog;
    };
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 834, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await t.test(
        `The last member can be managed at ${viewport.width}×${viewport.height}`,
        async () => {
          await page.setViewportSize(viewport);
          const dialog = await openTeam();
          try {
            const rows = dialog.locator("tbody tr");
            assert.equal(await rows.count(), 26);
            const lastRow = rows.filter({
              hasText: "Team Fixture Member 25",
            });
            assert.match(await lastRow.innerText(), /Inactive/);
            const scroller = dialog.locator(".single-settings");
            const before = await scroller.evaluate((element) => ({
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
              top: element.scrollTop,
            }));
            assert.ok(
              before.scrollHeight > before.clientHeight,
              "The full member list must have a scrollable area inside the dialog.",
            );
            const manage = lastRow.getByRole("button", {
              name: "Manage",
              exact: true,
            });
            await manage.scrollIntoViewIfNeeded();
            const position = await manage.boundingBox();
            assert.ok(position, "The last Manage control must be rendered.");
            assert.ok(
              position.y >= 0 &&
                position.y + position.height <= viewport.height,
              "The last Manage control must be reachable within the viewport.",
            );
            assert.ok(
              (await scroller.evaluate((element) => element.scrollTop)) >
                before.top,
              "Reaching the last member must scroll the member list.",
            );
            await manage.click();
            const edit = page.getByRole("dialog", {
              name: "Manage Team Member",
              exact: true,
            });
            await edit
              .getByText("Team Fixture Member 25", { exact: true })
              .waitFor();
            assert.equal(
              await edit.getByLabel("Account Status").inputValue(),
              "no",
            );
            const role = viewport.width === 1280 ? "editor" : "viewer";
            await edit.getByLabel("Role", { exact: true }).selectOption(role);
            await edit
              .getByRole("button", { name: "Save Access", exact: true })
              .click();
            await edit.waitFor({ state: "detached" });
            const persisted = await request("/users");
            assert.equal(persisted.length, 26);
            assert.equal(
              persisted.find((member) => member.id === members[24].id).role,
              role,
            );
            assert.equal(
              persisted.find((member) => member.id === members[24].id).active,
              false,
            );
            assert.deepEqual(
              persisted
                .filter((member) => member.id !== members[24].id)
                .sort((a, b) => a.id.localeCompare(b.id)),
              initial
                .filter((member) => member.id !== members[24].id)
                .sort((a, b) => a.id.localeCompare(b.id)),
              "Managing a member must preserve every other account and role.",
            );
            await page.screenshot({
              path: `/tmp/maestro-team-access-fixed-${viewport.width}.png`,
            });
            await dialog
              .getByRole("button", { name: "Close dialog", exact: true })
              .click();
          } catch (error) {
            await page.screenshot({
              path: `/tmp/maestro-team-access-${viewport.width}.png`,
              fullPage: true,
            });
            throw error;
          }
        },
      );
      // A failed geometry check leaves the outer dialog open.
      const open = page.getByRole("dialog", {
        name: "Team & Access",
        exact: true,
      });
      if (await open.count())
        await open
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
    }
    await t.test(
      "Search finds names, emails and inactive members without hiding the full workspace count",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        const dialog = await openTeam();
        const search = dialog.getByRole("searchbox", {
          name: "Search team members",
          exact: true,
        });
        await search.fill("FIXTURE MEMBER 25");
        assert.equal(await dialog.locator("tbody tr").count(), 1);
        assert.match(await dialog.locator("tbody tr").innerText(), /Inactive/);
        assert.match(
          await dialog
            .getByRole("heading", { name: /Workspace Members/ })
            .innerText(),
          /26/,
        );
        await search.fill("TEAM-MEMBER-18@EXAMPLE.TEST");
        assert.equal(await dialog.locator("tbody tr").count(), 1);
        assert.match(
          await dialog.locator("tbody tr").innerText(),
          /Team Fixture Member 18/,
        );
        await search.fill("member not present");
        assert.equal(await dialog.locator("tbody tr button").count(), 0);
        await dialog
          .getByRole("button", { name: "Clear member search", exact: true })
          .click();
        assert.equal(await search.inputValue(), "");
        assert.equal(await dialog.locator("tbody tr").count(), 26);
        await dialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
      },
    );
    await t.test(
      "Refresh loads a member added from another administrator session",
      async () => {
        const dialog = await openTeam();
        const second = await browser.newContext();
        try {
          await request(
            "/login",
            "POST",
            {
              email: administrator.email,
              password,
            },
            second,
          );
          const extra = await request(
            "/users",
            "POST",
            {
              name: "Another Session Member",
              email: "another-session-member@example.test",
              password,
              role: "viewer",
            },
            second,
          );
          assert.equal((await request("/users")).length, 27);
          assert.equal(await dialog.locator("tbody tr").count(), 26);
          await dialog
            .getByRole("button", { name: "Refresh Members", exact: true })
            .click();
          await dialog.getByText(extra.name, { exact: true }).waitFor();
          assert.equal(await dialog.locator("tbody tr").count(), 27);
          const saved = await request("/users");
          assert.deepEqual(
            saved.find((member) => member.id === extra.id),
            extra,
            "Refreshing must not change the member's role or account status.",
          );
          await dialog
            .getByRole("button", { name: "Close dialog", exact: true })
            .click();
        } finally {
          await second.close();
        }
      },
    );
    await t.test(
      "A failed refresh preserves the loaded members and can be retried",
      async () => {
        const dialog = await openTeam(27);
        const before = await request("/users");
        const usersUrl = base + "/api/users";
        await page.route(usersUrl, async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: "Fixture member refresh is unavailable.",
            }),
          });
        });
        try {
          await dialog
            .getByRole("button", { name: "Refresh Members", exact: true })
            .click();
          await dialog.getByRole("alert").waitFor();
          assert.match(
            await dialog.getByRole("alert").innerText(),
            /Fixture member refresh is unavailable/,
          );
          assert.equal(await dialog.locator("tbody tr").count(), 27);
          assert.deepEqual(await request("/users"), before);
        } finally {
          await page.unroute(usersUrl);
        }
        await dialog
          .getByRole("button", { name: "Refresh Members", exact: true })
          .click();
        await dialog.getByRole("alert").waitFor({ state: "detached" });
        assert.equal(await dialog.locator("tbody tr").count(), 27);
        await dialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
      },
    );
    await t.test(
      "Adding a member in Team & Access immediately updates the complete list",
      async () => {
        const dialog = await openTeam(27);
        await dialog
          .getByRole("button", { name: "Add Team Member", exact: true })
          .click();
        const add = page.getByRole("dialog", {
          name: "Add Team Member",
          exact: true,
        });
        await add
          .getByLabel("Full Name", { exact: true })
          .fill("Added Through Team Page");
        await add
          .getByLabel("Email Address", { exact: true })
          .fill("added-in-team-page@example.test");
        await add.getByLabel("Password", { exact: true }).fill(password);
        await add.getByLabel("Role", { exact: true }).selectOption("editor");
        await add
          .getByRole("button", { name: "Save Access", exact: true })
          .click();
        await add.waitFor({ state: "detached" });
        await dialog
          .getByText("Added Through Team Page", { exact: true })
          .waitFor();
        assert.equal(await dialog.locator("tbody tr").count(), 28);
        const saved = await request("/users");
        assert.equal(saved.length, 28);
        const added = saved.find(
          (member) => member.email === "added-in-team-page@example.test",
        );
        assert.equal(added.role, "editor");
        assert.equal(added.active, true);
        await dialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
      },
    );
    await t.test(
      "A successful member save remains visible when the following refresh fails, and retry creates no duplicate",
      async () => {
        const dialog = await openTeam(28);
        await dialog
          .getByRole("button", { name: "Add Team Member", exact: true })
          .click();
        const add = page.getByRole("dialog", {
          name: "Add Team Member",
          exact: true,
        });
        await add
          .getByLabel("Full Name", { exact: true })
          .fill("Saved Before Failed Refresh");
        await add
          .getByLabel("Email Address", { exact: true })
          .fill("saved-with-refresh-error@example.test");
        await add.getByLabel("Password", { exact: true }).fill(password);
        await add.getByLabel("Role", { exact: true }).selectOption("viewer");
        const usersUrl = base + "/api/users";
        let createRequests = 0;
        await page.route(usersUrl, async (route) => {
          if (route.request().method() === "POST") {
            createRequests++;
            return route.continue();
          }
          if (route.request().method() !== "GET") return route.continue();
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: "Fixture member refresh is unavailable.",
            }),
          });
        });
        try {
          await add
            .getByRole("button", { name: "Save Access", exact: true })
            .click();
          await add.waitFor({ state: "detached" });
          await dialog.getByRole("alert").waitFor();
          await dialog
            .getByText("Saved Before Failed Refresh", { exact: true })
            .waitFor();
          assert.equal(await dialog.locator("tbody tr").count(), 29);
          assert.equal(createRequests, 1);
          const saved = await request("/users");
          assert.equal(saved.length, 29);
          const member = saved.filter(
            (row) => row.email === "saved-with-refresh-error@example.test",
          );
          assert.equal(member.length, 1);
          assert.equal(member[0].role, "viewer");
          assert.equal(member[0].active, true);
        } finally {
          await page.unroute(usersUrl);
        }
        await dialog
          .getByRole("button", { name: "Refresh Members", exact: true })
          .click();
        await dialog.getByRole("alert").waitFor({ state: "detached" });
        assert.equal(await dialog.locator("tbody tr").count(), 29);
        assert.equal(createRequests, 1);
        assert.equal((await request("/users")).length, 29);
        await dialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
      },
    );
    await t.test(
      "Editors and viewers cannot open or modify Team & Access",
      async () => {
        for (const member of [members[0], members[1]]) {
          const restricted = await browser.newContext();
          try {
            await request(
              "/login",
              "POST",
              {
                email: member.email,
                password,
              },
              restricted,
            );
            const restrictedPage = await restricted.newPage();
            await restrictedPage.goto(base);
            await restrictedPage
              .getByRole("heading", {
                name: "Digital Government Forum",
                exact: true,
              })
              .waitFor();
            assert.equal(
              await restrictedPage
                .getByRole("button", { name: "Team & Access", exact: true })
                .count(),
              0,
            );
            for (const options of [
              { method: "GET" },
              {
                method: "POST",
                data: {
                  name: "Unauthorized",
                  email: "unauthorized@example.test",
                  password,
                  role: "admin",
                },
              },
            ]) {
              const response = await restricted.request.fetch(
                base + "/api/users",
                {
                  ...options,
                  headers: { "X-Requested-With": "Maestro" },
                },
              );
              assert.equal(response.status(), 403);
            }
          } finally {
            await restricted.close();
          }
        }
        assert.equal((await request("/users")).length, 29);
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
    rmSync(dir, { recursive: true, force: true });
  }
});
