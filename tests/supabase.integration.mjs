import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import { cloudBrowser } from "./cloud-browser.mjs";
import { createHandler } from "../supabase/functions/maestro-api/handler.mjs";
const config = JSON.parse(
  await readFile(process.env.SUPABASE_TEST_CONFIG, "utf8"),
);
if (new URL(config.API_URL).hostname !== "127.0.0.1")
  throw new Error(
    "Cloud integration tests require the isolated local Supabase stack.",
  );
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options);
const client = () => createClient(config.API_URL, config.ANON_KEY, options);
const origin = "https://maestro.example.test";
let handler = createHandler(db, { origins: [origin] });
const users = [],
  sponsorIds = [],
  packageIds = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
  "base64",
);
const file = (name, bytes, type = "image/png") =>
  new File([bytes], name, { type });
const form = (kind, files) => {
  const f = new FormData();
  f.set("kind", kind);
  files.forEach((v) => f.append("files", v));
  return f;
};
async function request(
  path,
  method = "GET",
  body,
  token,
  requestOrigin = origin,
) {
  const headers = { Origin: requestOrigin };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined && !(body instanceof FormData))
    headers["Content-Type"] = "application/json";
  return handler(
    new Request("http://edge.test/functions/v1/maestro-api" + path, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    }),
  );
}
async function good(path, method, body, token) {
  const r = await request(path, method, body, token);
  assert.ok(
    r.ok,
    `${method || "GET"} ${path}: ${r.status} ${r.ok ? "" : await r.text()}`,
  );
  return r.json();
}
async function makeUser(role) {
  const email = `${randomUUID()}@example.test`,
    password = randomBytes(24).toString("hex");
  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.equal(error, null);
  users.push(data.user.id);
  const p =
    role === "admin"
      ? await db.rpc("maestro_bootstrap_admin", {
          account_email: email,
          display_name: "Cloud test admin",
        })
      : await db.from("maestro_profiles").insert({
          id: data.user.id,
          email,
          name: "Cloud test " + role,
          role,
        });
  assert.equal(p.error, null);
  const auth = client();
  const login = await auth.auth.signInWithPassword({ email, password });
  assert.equal(login.error, null);
  return {
    id: data.user.id,
    token: login.data.session.access_token,
    auth,
    email,
    password,
  };
}
async function startEdge(uiOrigin) {
  const edge = spawn(
    "node_modules/.bin/deno",
    [
      "run",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      "--node-modules-dir=manual",
      "--config",
      "supabase/functions/maestro-api/deno.json",
      "supabase/functions/maestro-api/index.ts",
    ],
    {
      env: {
        ...process.env,
        DENO_DIR: "/workspace/.maestro-deno-cache",
        ...(process.env.NODE_EXTRA_CA_CERTS
          ? { DENO_CERT: process.env.NODE_EXTRA_CA_CERTS }
          : {}),
        SUPABASE_URL: config.API_URL,
        SUPABASE_SERVICE_ROLE_KEY: config.SERVICE_ROLE_KEY,
        ALLOWED_ORIGINS: origin + "," + uiOrigin,
        PORT: "8877",
        HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Deno startup timed out")),
      30000,
    );
    const receive = (d) => {
      output += d;
      if (output.includes("Listening on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    edge.stdout.on("data", receive);
    edge.stderr.on("data", receive);
    edge.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Deno failed to start: " + output));
    });
  });
  return edge;
}
await test("Supabase Auth, database, private storage and API integration", async (t) => {
  try {
    const admin = await makeUser("admin"),
      editor = await makeUser("editor"),
      viewer = await makeUser("viewer");
    let sponsor, other, pkg;
    await t.test(
      "no public signup, table access or unauthenticated API access",
      async () => {
        assert.equal((await request("/health")).status, 200);
        assert.equal((await request("/sponsors")).status, 401);
        assert.equal(
          (await request("/sponsors", "GET", undefined, "forged")).status,
          401,
        );
        assert.equal(
          (
            await request(
              "/sponsors",
              "GET",
              undefined,
              admin.token,
              "https://untrusted.test",
            )
          ).status,
          403,
        );
        assert.equal((await request("/sponsors", "OPTIONS")).status, 204);
        assert.ok((await client().from("maestro_sponsors").select("*")).error);
        assert.ok(
          (await viewer.auth.from("maestro_sponsors").select("*")).error,
        );
        assert.ok(
          (
            await viewer.auth.rpc("maestro_touch_sponsor", {
              sponsor: randomUUID(),
            })
          ).error,
        );
        const signup = await client().auth.signUp({
          email: randomUUID() + "@example.test",
          password: randomBytes(24).toString("hex"),
        });
        assert.ok(signup.error);
      },
    );
    await t.test(
      "independent statuses, precise finances, input validation and role enforcement",
      async () => {
        pkg = await good(
          "/packages",
          "POST",
          { name: "Cloud test package", benefits: ["Test benefit"] },
          editor.token,
        );
        packageIds.push(pkg.id);
        const input = {
          name: "Cloud test sponsor",
          packageId: pkg.id,
          contact: "Cloud test contact",
          mobile: "+966501234567",
          email: "contact@example.test",
          approval: "Approved",
          approvalDate: "2026-10-05",
          poIssued: false,
          poNumber: "",
          poDate: "",
          value: 10000,
          payments: [
            {
              id: randomUUID(),
              amount: 1500.25,
              date: "2026-10-05",
              note: "Cloud test payment",
            },
          ],
          benefits: [
            { id: randomUUID(), title: "Cloud test benefit", completed: true },
          ],
          notes: "Cloud test notes",
        };
        sponsor = await good("/sponsors", "POST", input, editor.token);
        sponsorIds.push(sponsor.id);
        assert.equal(sponsor.outstanding, 8499.75);
        assert.equal(sponsor.poIssued, false);
        assert.equal(sponsor.approval, "Approved");
        assert.equal(sponsor.received, 1500.25);
        assert.equal(
          (await request("/sponsors", "POST", input, viewer.token)).status,
          403,
        );
        assert.equal(
          (
            await request(
              "/sponsors",
              "POST",
              { ...input, email: "bad" },
              editor.token,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              "/sponsors",
              "POST",
              { ...input, approvalDate: "2026-02-31" },
              editor.token,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              "/sponsors",
              "POST",
              { ...input, value: 2.123 },
              editor.token,
            )
          ).status,
          400,
        );
        other = await good(
          "/sponsors",
          "POST",
          { ...input, name: "Cloud test other" },
          admin.token,
        );
        sponsorIds.push(other.id);
        assert.equal(
          (
            await request(
              "/packages/" + pkg.id,
              "DELETE",
              undefined,
              admin.token,
            )
          ).status,
          409,
        );
      },
    );
    await t.test("concurrent saves reject stale revisions", async () => {
      const results = await Promise.all([
        request(
          "/sponsors/" + sponsor.id,
          "PUT",
          { ...sponsor, notes: "First save" },
          editor.token,
        ),
        request(
          "/sponsors/" + sponsor.id,
          "PUT",
          { ...sponsor, notes: "Second save" },
          editor.token,
        ),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      sponsor = await good(
        "/sponsors/" + sponsor.id,
        "GET",
        undefined,
        admin.token,
      );
    });
    await t.test(
      "private files, ownership, replacement and deletion",
      async () => {
        sponsor = await good(
          "/sponsors/" + sponsor.id + "/attachments",
          "POST",
          form("approval", [file("approval.png", png)]),
          editor.token,
        );
        const a = sponsor.attachments[0];
        assert.equal(a.kind, "approval");
        assert.equal(a.sponsorId, sponsor.id);
        const image = await fetch(a.url);
        assert.equal(image.status, 200);
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
        const objects = await db
          .from("maestro_attachments")
          .select("path")
          .eq("id", a.id)
          .single();
        const publicDownload = await client()
          .storage.from("maestro-files")
          .download(objects.data.path);
        assert.ok(publicDownload.error);
        assert.equal(
          (
            await request(
              "/sponsors/" + sponsor.id + "/attachments",
              "POST",
              form("approval", [file("fake.png", Buffer.from("not an image"))]),
              editor.token,
            )
          ).status,
          400,
        );
        const replace = new FormData();
        replace.set("file", file("replacement.png", png));
        sponsor = await good(
          "/attachments/" + a.id + "/replace",
          "POST",
          replace,
          editor.token,
        );
        assert.equal(sponsor.attachments[0].sponsorId, sponsor.id);
        assert.equal(sponsor.attachments[0].kind, "approval");
        assert.equal(sponsor.attachments[0].name, "replacement.png");
        assert.equal(
          (await good("/sponsors/" + other.id, "GET", undefined, admin.token))
            .attachments.length,
          0,
        );
        const r = await request("/export/pdf", "GET", undefined, admin.token);
        assert.equal(r.status, 200);
        sponsor = await good(
          "/sponsors/" + sponsor.id + "/attachments",
          "POST",
          form("purchase-order", [
            file("order.pdf", await r.arrayBuffer(), "application/pdf"),
          ]),
          editor.token,
        );
        assert.equal(sponsor.attachments.length, 2);
        assert.equal(sponsor.poIssued, false);
        assert.equal(
          (
            await request(
              "/attachments/" + a.id,
              "DELETE",
              undefined,
              viewer.token,
            )
          ).status,
          403,
        );
        const logo = new FormData();
        logo.set("file", file("brand.png", png));
        await good("/brand/logo", "POST", logo, admin.token);
      },
    );
    await t.test(
      "real branded Excel and PDF reports and persistence",
      async () => {
        const response = await request(
          "/export/excel?ids=" + sponsor.id,
          "GET",
          undefined,
          viewer.token,
        );
        assert.equal(response.status, 200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));
        assert.equal(wb.worksheets.length, 4);
        assert.equal(
          wb.getWorksheet("Sponsors").getCell("A5").value,
          sponsor.name,
        );
        assert.equal(wb.getWorksheet("Sponsors").getCell("M5").value, 8499.75);
        assert.equal(wb.getWorksheet("Sponsors").getImages().length, 1);
        assert.equal(wb.getWorksheet("Payments").getCell("B5").value, 1500.25);
        const pdf = await request(
          "/export/pdf?ids=" + sponsor.id,
          "GET",
          undefined,
          viewer.token,
        );
        assert.equal(pdf.status, 200);
        assert.equal(
          Buffer.from(await pdf.arrayBuffer())
            .subarray(0, 5)
            .toString(),
          "%PDF-",
        );
        handler = createHandler(
          createClient(config.API_URL, config.SERVICE_ROLE_KEY, options),
          { origins: [origin] },
        );
        const persisted = await good(
          "/sponsors/" + sponsor.id,
          "GET",
          undefined,
          admin.token,
        );
        assert.equal(persisted.outstanding, 8499.75);
        assert.equal(persisted.attachments.length, 2);
      },
    );
    await t.test(
      "Deno Edge entrypoint serves authenticated HTTP requests",
      async () => {
        const edge = spawn(
          "node_modules/.bin/deno",
          [
            "run",
            "--allow-env",
            "--allow-net",
            "--allow-read",
            "--node-modules-dir=manual",
            "--config",
            "supabase/functions/maestro-api/deno.json",
            "supabase/functions/maestro-api/index.ts",
          ],
          {
            env: {
              ...process.env,
              DENO_DIR: "/workspace/.maestro-deno-cache",
              ...(process.env.NODE_EXTRA_CA_CERTS
                ? { DENO_CERT: process.env.NODE_EXTRA_CA_CERTS }
                : {}),
              SUPABASE_URL: config.API_URL,
              SUPABASE_SERVICE_ROLE_KEY: config.SERVICE_ROLE_KEY,
              ALLOWED_ORIGINS: origin,
              PORT: "8877",
              HOST: "127.0.0.1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        try {
          await new Promise((resolve, reject) => {
            let output = "";
            const timer = setTimeout(
              () => reject(new Error("Deno startup timed out")),
              30000,
            );
            const receive = (d) => {
              output += d;
              if (output.includes("Listening on")) {
                clearTimeout(timer);
                resolve();
              }
            };
            edge.stdout.on("data", receive);
            edge.stderr.on("data", receive);
            edge.once("exit", () => {
              clearTimeout(timer);
              reject(new Error("Deno failed to start: " + output));
            });
          });
          const headers = {
            Origin: origin,
            Authorization: "Bearer " + admin.token,
          };
          const response = await fetch(
            "http://127.0.0.1:8877/maestro-api/sponsors/" + sponsor.id,
            { headers },
          );
          assert.equal(response.status, 200);
          assert.equal((await response.json()).outstanding, 8499.75);
          const excel = await fetch(
            "http://127.0.0.1:8877/maestro-api/export/excel?ids=" + sponsor.id,
            { headers },
          );
          assert.equal(excel.status, 200);
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(Buffer.from(await excel.arrayBuffer()));
          assert.equal(
            wb.getWorksheet("Sponsors").getCell("A5").value,
            sponsor.name,
          );
          const pdf = await fetch(
            "http://127.0.0.1:8877/maestro-api/export/pdf?ids=" + sponsor.id,
            { headers },
          );
          assert.equal(pdf.status, 200);
          assert.equal(
            Buffer.from(await pdf.arrayBuffer())
              .subarray(0, 5)
              .toString(),
            "%PDF-",
          );
        } finally {
          if (edge.exitCode === null) {
            await new Promise((resolve) => {
              edge.once("exit", resolve);
              edge.kill("SIGTERM");
            });
          }
        }
      },
    );
    await t.test(
      "GitHub Pages frontend signs in, saves, reloads, edits, previews and exports through Supabase",
      async () => {
        await cloudBrowser({
          config,
          admin,
          viewer,
          db,
          sponsorIds,
          startEdge,
        });
      },
    );
    await t.test(
      "team changes, self protection and immediate session revocation",
      async () => {
        assert.equal(
          (await request("/users", "GET", undefined, editor.token)).status,
          403,
        );
        assert.equal(
          (
            await request(
              "/users/" + admin.id,
              "PATCH",
              { role: "viewer", active: true },
              admin.token,
            )
          ).status,
          400,
        );
        const member = await good(
          "/users",
          "POST",
          {
            name: "Test member",
            email: randomUUID() + "@example.test",
            password: randomBytes(24).toString("hex"),
            role: "viewer",
          },
          admin.token,
        );
        users.push(member.id);
        await good(
          "/users/" + editor.id,
          "PATCH",
          { role: "editor", active: false },
          admin.token,
        );
        assert.equal(
          (await request("/sponsors", "GET", undefined, editor.token)).status,
          401,
        );
        await good(
          "/users/" + editor.id,
          "PATCH",
          { role: "editor", active: true },
          admin.token,
        );
        assert.equal(
          (await request("/sponsors", "GET", undefined, editor.token)).status,
          401,
        );
        const refreshed = await editor.auth.auth.refreshSession();
        assert.ok(refreshed.error);
      },
    );
  } finally {
    for (const id of sponsorIds) {
      const { data: files } = await db
        .from("maestro_attachments")
        .select("path")
        .eq("sponsor_id", id);
      if (files?.length)
        await db.storage.from("maestro-files").remove(files.map((f) => f.path));
      await db.from("maestro_sponsors").delete().eq("id", id);
    }
    for (const id of packageIds)
      await db.from("maestro_packages").delete().eq("id", id);
    const { data: b } = await db
      .from("maestro_settings")
      .select("data")
      .eq("id", "brand")
      .single();
    if (b?.data.logoPath)
      await db.storage.from("maestro-files").remove([b.data.logoPath]);
    await db
      .from("maestro_settings")
      .update({
        data: { organization: "MAESTRO", accent: "#536b62", configured: false },
      })
      .eq("id", "brand");
    for (const id of users) await db.auth.admin.deleteUser(id);
  }
});
