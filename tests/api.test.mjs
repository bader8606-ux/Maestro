import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";

const dir = mkdtempSync(path.join(tmpdir(), "maestro-api-"));
let server,
  base,
  cookie = "";
const password = randomBytes(24).toString("hex");
async function start() {
  server = spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Server did not start.")),
      30000,
    );
    let output = "";
    server.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve("http://127.0.0.1:" + match[1]);
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("Server exited: " + code));
    });
    server.stderr.on("data", (data) => process.stderr.write(data));
  });
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill("SIGTERM");
  });
}
async function request(url, method = "GET", data, session = cookie) {
  return fetch(base + "/api" + url, {
    method,
    headers: {
      "X-Requested-With": "Maestro",
      ...(session ? { Cookie: session } : {}),
      ...(data !== undefined && !(data instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body:
      data === undefined
        ? undefined
        : data instanceof FormData
          ? data
          : JSON.stringify(data),
  });
}
async function json(url, method = "GET", data, session = cookie) {
  const res = await request(url, method, data, session);
  const body = await res.json();
  assert.ok(res.ok, JSON.stringify(body));
  return body;
}
const session = (res) => res.headers.getSetCookie()[0].split(";")[0];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
  "base64",
);
const sponsorInput = () => ({
  name: "Integration test record",
  packageId: "",
  contact: "Test contact",
  mobile: "+966501234567",
  email: "contact@example.test",
  approval: "Not Approved",
  approvalDate: "",
  poIssued: false,
  poNumber: "",
  poDate: "",
  value: 1000.1,
  payments: [],
  benefits: [],
  notes: "",
});

await test("Persistent sponsor management workflow", async (t) => {
  try {
    await start();
    await t.test(
      "Starts empty and requires secure administrator setup",
      async () => {
        assert.deepEqual(await json("/health"), {
          status: "ok",
          setupRequired: true,
        });
        assert.equal((await request("/sponsors")).status, 401);
        assert.equal(
          (
            await request("/setup", "POST", {
              ...sponsorInput(),
              token: "wrong",
              email: "admin@example.test",
              name: "Test administrator",
              password,
            })
          ).status,
          403,
        );
        const res = await request("/setup", "POST", {
          name: "Test administrator",
          email: "admin@example.test",
          password,
          token: readFileSync(path.join(dir, "setup-token"), "utf8"),
        });
        assert.equal(res.status, 201);
        cookie = session(res);
        assert.equal((await res.json()).role, "admin");
        assert.equal(existsSync(path.join(dir, "setup-token")), false);
        assert.deepEqual(await json("/sponsors"), []);
        assert.deepEqual(await json("/packages"), []);
        const brand = await json("/brand");
        assert.equal(brand.accent, "#0078B5");
        assert.equal(brand.logoIsDefault, true);
        const originalLogo = Buffer.from(
          await (await request("/brand/logo")).arrayBuffer(),
        );
        assert.deepEqual(
          originalLogo,
          readFileSync("public/brand/maestro-logo.png"),
        );
        const emptyReport = new ExcelJS.Workbook();
        await emptyReport.xlsx.load(
          Buffer.from(await (await request("/export/excel")).arrayBuffer()),
        );
        assert.equal(
          emptyReport.getWorksheet("Sponsors").getImages().length,
          1,
        );
        assert.equal(
          emptyReport
            .getWorksheet("Sponsors")
            .getCell("A4")
            .fill.fgColor.argb.toUpperCase(),
          "FF0078B5",
        );
        assert.deepEqual(
          Buffer.from(emptyReport.model.media[0].buffer),
          originalLogo,
        );
        const emptyPdf = Buffer.from(
          await (await request("/export/pdf")).arrayBuffer(),
        );
        assert.ok(
          emptyPdf.toString("latin1").includes("Poppins-Regular"),
          "PDF names the supplied Poppins font.",
        );
        assert.ok(
          emptyPdf.toString("latin1").includes("/FontFile2"),
          "PDF embeds TrueType font bytes.",
        );
        assert.equal((await request("/setup", "POST", {})).status, 409);
      },
    );
    let pkg, s, attachment, poAttachment, viewerCookie, editorCookie, viewerId;
    await t.test(
      "Rejects CSRF, bad credentials, and invalid input",
      async () => {
        assert.equal(
          (
            await fetch(base + "/api/packages", {
              method: "POST",
              headers: { Cookie: cookie, "Content-Type": "application/json" },
              body: "{}",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/login", "POST", {
              email: "admin@example.test",
              password: "incorrect",
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request("/sponsors", "POST", {
              ...sponsorInput(),
              email: "not-an-email",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request("/sponsors", "POST", {
              ...sponsorInput(),
              mobile: "0501234567",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request("/sponsors", "POST", {
              ...sponsorInput(),
              approvalDate: "2026-02-31",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request("/sponsors", "POST", {
              ...sponsorInput(),
              value: 1.001,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request("/sponsors", "POST", {
              ...sponsorInput(),
              packageId: randomUUID(),
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "Persists optional package catalogue prices without changing sponsor finances",
      async () => {
        const input = {
          name: "Catalogue price test package",
          benefits: ["A benefit supplied by the catalogue"],
          referenceValue: 125000.25,
        };
        const priced = await json("/packages", "POST", input);
        assert.equal(priced.referenceValue, input.referenceValue);
        assert.equal(
          (await json("/packages")).find((p) => p.id === priced.id)
            .referenceValue,
          input.referenceValue,
        );
        const revised = await json("/packages/" + priced.id, "PUT", {
          ...input,
          referenceValue: 250000.5,
        });
        assert.equal(revised.referenceValue, 250000.5);
        for (const invalid of [-1, 1.001, 10000000000, "125000", null]) {
          for (const [url, method] of [
            ["/packages", "POST"],
            ["/packages/" + priced.id, "PUT"],
          ]) {
            assert.equal(
              (
                await request(url, method, {
                  ...input,
                  referenceValue: invalid,
                })
              ).status,
              400,
              `Rejects invalid catalogue value ${JSON.stringify(invalid)} on ${method}`,
            );
          }
        }
        assert.equal(
          (await json("/packages")).find((p) => p.id === priced.id)
            .referenceValue,
          revised.referenceValue,
          "Invalid edits leave the saved catalogue price unchanged.",
        );
        const actual = await json("/sponsors", "POST", {
          ...sponsorInput(),
          packageId: priced.id,
        });
        assert.equal(actual.value, sponsorInput().value);
        assert.equal(actual.received, 0);
        assert.equal(actual.outstanding, sponsorInput().value);
        assert.equal(actual.approval, "Not Approved");
        assert.equal(actual.poIssued, false);
        await json("/sponsors/" + actual.id, "DELETE");
        const withoutPrice = await json("/packages/" + priced.id, "PUT", {
          name: input.name,
          benefits: input.benefits,
        });
        assert.equal("referenceValue" in withoutPrice, false);
        assert.equal(
          "referenceValue" in
            (await json("/packages")).find((p) => p.id === priced.id),
          false,
          "An omitted price remains absent instead of inventing a zero price.",
        );
        await json("/packages/" + priced.id, "DELETE");
      },
    );
    await t.test(
      "Creates editable packages and independent sponsor statuses",
      async () => {
        pkg = await json("/packages", "POST", {
          name: "Integration package",
          benefits: ["Integration benefit"],
        });
        assert.equal("referenceValue" in pkg, false);
        pkg = await json("/packages/" + pkg.id, "PUT", {
          name: "Updated integration package",
          benefits: ["Integration benefit"],
        });
        assert.equal("referenceValue" in pkg, false);
        s = await json("/sponsors", "POST", {
          ...sponsorInput(),
          packageId: pkg.id,
          benefits: [
            {
              id: randomUUID(),
              title: "Integration benefit",
              completed: false,
            },
          ],
        });
        assert.equal(s.packageName, pkg.name);
        assert.equal(s.received, 0);
        assert.equal(s.outstanding, 1000.1);
        assert.equal(s.approval, "Not Approved");
        assert.equal(s.poIssued, false);
        assert.equal(
          (await request("/packages/" + pkg.id, "DELETE")).status,
          409,
        );
      },
    );
    await t.test(
      "Calculates payments precisely and detects conflicting edits",
      async () => {
        const old = s;
        s = await json("/sponsors/" + s.id, "PUT", {
          ...s,
          payments: [
            {
              id: randomUUID(),
              amount: 100.1,
              date: "2026-10-05",
              note: "Integration payment",
            },
          ],
          benefits: s.benefits.map((b) => ({ ...b, completed: true })),
        });
        assert.equal(s.received, 100.1);
        assert.equal(s.outstanding, 900);
        assert.equal(s.approval, "Not Approved");
        assert.equal(s.poIssued, false);
        assert.equal(s.benefits[0].completed, true);
        assert.equal(
          (
            await request("/sponsors/" + s.id, "PUT", {
              ...old,
              name: "Stale record",
            })
          ).status,
          409,
        );
        s = await json("/sponsors/" + s.id, "PUT", {
          ...s,
          approval: "Approved",
          approvalDate: "2026-10-05",
        });
        assert.equal(s.poIssued, false);
        assert.equal(s.received, 100.1);
        s = await json("/sponsors/" + s.id, "PUT", {
          ...s,
          poIssued: true,
          poNumber: "TEST-PO",
          poDate: "2026-10-05",
        });
        assert.equal(s.approval, "Approved");
        assert.equal(s.received, 100.1);
        assert.ok(s.updatedAt);
      },
    );
    await t.test(
      "Uploads, previews, downloads, replaces and separately links files",
      async () => {
        const form = new FormData();
        form.set("kind", "approval");
        form.append(
          "files",
          new Blob([png], { type: "image/png" }),
          "approval.png",
        );
        s = await json("/sponsors/" + s.id + "/attachments", "POST", form);
        attachment = s.attachments[0];
        assert.equal(attachment.kind, "approval");
        const preview = await request("/attachments/" + attachment.id);
        assert.equal(preview.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
        const download = await request(
          "/attachments/" + attachment.id + "?download=1",
        );
        assert.match(
          download.headers.get("content-disposition"),
          /^attachment/,
        );
        const pdf = new FormData();
        pdf.set("kind", "purchase-order");
        pdf.append(
          "files",
          new Blob(["%PDF-1.4\n% integration test"], {
            type: "application/pdf",
          }),
          "order.pdf",
        );
        s = await json("/sponsors/" + s.id + "/attachments", "POST", pdf);
        poAttachment = s.attachments.find((a) => a.kind === "purchase-order");
        assert.equal(s.attachments.length, 2);
        assert.equal(poAttachment.sponsorId, s.id);
        const replacement = new FormData();
        replacement.append(
          "file",
          new Blob([png], { type: "image/png" }),
          "replaced.png",
        );
        s = await json(
          "/attachments/" + attachment.id + "/replace",
          "POST",
          replacement,
        );
        assert.equal(
          s.attachments.find((a) => a.id === attachment.id).name,
          "replaced.png",
        );
        assert.equal(
          s.attachments.find((a) => a.id === poAttachment.id).name,
          "order.pdf",
        );
        const invalid = new FormData();
        invalid.set("kind", "approval");
        invalid.append(
          "files",
          new Blob(["<script>bad</script>"], { type: "image/png" }),
          "fake.png",
        );
        assert.equal(
          (await request("/sponsors/" + s.id + "/attachments", "POST", invalid))
            .status,
          400,
        );
      },
    );
    await t.test(
      "Enforces viewer, editor and administrator permissions",
      async () => {
        const viewer = await json("/users", "POST", {
          name: "Test viewer",
          email: "viewer@example.test",
          password,
          role: "viewer",
        });
        viewerId = viewer.id;
        await json("/users", "POST", {
          name: "Test editor",
          email: "editor@example.test",
          password,
          role: "editor",
        });
        const vr = await request("/login", "POST", {
          email: viewer.email,
          password,
        });
        viewerCookie = session(vr);
        const er = await request("/login", "POST", {
          email: "editor@example.test",
          password,
        });
        editorCookie = session(er);
        assert.equal(
          (await request("/sponsors", "GET", undefined, viewerCookie)).status,
          200,
        );
        assert.equal(
          (
            await request(
              "/attachments/" + attachment.id,
              "GET",
              undefined,
              viewerCookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (await request("/sponsors/" + s.id, "PUT", s, viewerCookie)).status,
          403,
        );
        assert.equal(
          (
            await request(
              "/packages",
              "POST",
              { name: "Unauthorized", benefits: [] },
              viewerCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (await request("/users", "GET", undefined, viewerCookie)).status,
          403,
        );
        assert.equal(
          (await request("/users", "GET", undefined, editorCookie)).status,
          403,
        );
        assert.equal(
          (
            await request(
              "/brand",
              "PUT",
              { organization: "MAESTRO", accent: "#112233" },
              editorCookie,
            )
          ).status,
          403,
        );
        s = await json(
          "/sponsors/" + s.id,
          "PUT",
          { ...s, notes: "Editor verified" },
          editorCookie,
        );
        const me = await json("/me");
        assert.equal(
          (
            await request("/users/" + me.id, "PATCH", {
              role: "viewer",
              active: true,
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "Exports English Excel and PDF with actual finances and no invented records",
      async () => {
        await json("/brand", "PUT", {
          organization: "MAESTRO",
          accent: "#112233",
        });
        const logo = new FormData();
        logo.append(
          "file",
          new Blob([png], { type: "image/png" }),
          "official-test-logo.png",
        );
        await json("/brand/logo", "POST", logo);
        assert.equal((await json("/brand")).logoIsDefault, false);
        const excel = await request(
          "/export/excel",
          "GET",
          undefined,
          viewerCookie,
        );
        assert.equal(excel.status, 200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(await excel.arrayBuffer()));
        const sheet = wb.getWorksheet("Sponsors");
        assert.equal(sheet.getCell("A5").value, s.name);
        assert.equal(sheet.getCell("K5").value, 1000.1);
        assert.equal(sheet.getCell("L5").value, 100.1);
        assert.equal(sheet.getCell("M5").value, 900);
        assert.equal(wb.getWorksheet("Payments").rowCount, 2);
        assert.equal(wb.getWorksheet("Attachments").rowCount, 3);
        assert.equal(sheet.getImages().length, 1);
        const filtered = await request("/export/excel?ids=");
        const wb2 = new ExcelJS.Workbook();
        await wb2.xlsx.load(Buffer.from(await filtered.arrayBuffer()));
        assert.equal(wb2.getWorksheet("Sponsors").rowCount, 4);
        const pdf = await request("/export/pdf");
        assert.equal(pdf.status, 200);
        const pdfBytes = Buffer.from(await pdf.arrayBuffer());
        assert.equal(pdfBytes.subarray(0, 5).toString(), "%PDF-");
        assert.ok(pdfBytes.length > 1500);
      },
    );
    await t.test(
      "Persists records, attachments and sessions after server restart",
      async () => {
        await stop();
        await start();
        const persisted = await json("/sponsors/" + s.id);
        assert.equal(persisted.name, s.name);
        assert.equal(persisted.received, 100.1);
        assert.equal(persisted.outstanding, 900);
        assert.equal(persisted.attachments.length, 2);
        assert.equal(persisted.notes, "Editor verified");
        assert.equal(
          (await request("/attachments/" + attachment.id)).status,
          200,
        );
        assert.equal((await json("/brand")).configured, true);
        assert.equal((await request("/brand/logo")).status, 200);
        assert.equal((await json("/me")).role, "admin");
      },
    );
    await t.test(
      "Revokes disabled accounts and deletes files and records",
      async () => {
        await json("/users/" + viewerId, "PATCH", {
          role: "viewer",
          active: false,
        });
        assert.equal(
          (await request("/sponsors", "GET", undefined, viewerCookie)).status,
          401,
        );
        s = await json("/attachments/" + attachment.id, "DELETE");
        assert.equal(s.attachments.length, 1);
        assert.equal(
          (await request("/attachments/" + attachment.id)).status,
          404,
        );
        await json("/sponsors/" + s.id, "DELETE");
        assert.deepEqual(await json("/sponsors"), []);
        assert.equal(
          (await request("/attachments/" + poAttachment.id)).status,
          404,
        );
        await json("/packages/" + pkg.id, "DELETE");
        assert.deepEqual(await json("/packages"), []);
        await json("/logout", "POST");
        assert.equal((await request("/me")).status, 401);
      },
    );
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
