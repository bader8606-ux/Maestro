import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { reports } from "../supabase/functions/maestro-api/reports.mjs";

const fields = {
  packageId: "",
  packageName: "",
  contact: "",
  mobile: "",
  email: "",
  approval: "Not Approved",
  approvalDate: "",
  poIssued: false,
  poNumber: "",
  poDate: "",
  value: 100,
  received: 0,
  outstanding: 100,
  payments: [],
  benefits: [],
  notes: "",
  updatedAt: "2026-10-07T00:00:00.000Z",
};
const sections = [
  ["approval", "Approval Attachments", "approval.png"],
  ["purchase-order", "Purchase Order Attachments", "order.png"],
  ["logo", "Sponsor Logo", "logo.png"],
  ["booth-location", "Booth Location Attachments", "location.png"],
  ["booth-design", "Booth Design Attachments", "design.png"],
];
const fixtures = [
  {
    ...fields,
    name: "Booth report fixture",
    boothSize: "6 x 4 m",
    boothLocation: "Hall A - Stand B12",
    attachments: sections.map(([kind, , name]) => ({
      kind,
      name,
      mime: "image/png",
      size: 68,
      createdAt: fields.updatedAt,
      url: "https://example.test/private-file?token=PRIVATE_CONTENT_FIXTURE",
    })),
  },
  { ...fields, name: "Legacy report fixture", attachments: [] },
];

async function workbook(bytes) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes));
  return book;
}

async function pdfText(bytes) {
  const dir = await mkdtemp(join(tmpdir(), "maestro-booth-pdf-"));
  try {
    const file = join(dir, "report.pdf");
    await writeFile(file, bytes);
    const { stdout } = await promisify(execFile)("pdftotext", [
      "-layout",
      file,
      "-",
    ]);
    return stdout
      .normalize("NFKC")
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Cloud Excel includes booth fields and section labels without exposing attachment links", async () => {
  const output = await reports("excel", fixtures, {});
  const book = await workbook(output.bytes);
  const sponsors = book.getWorksheet("Sponsors");
  assert.equal(sponsors.getCell("Q4").value, "Booth Size");
  assert.equal(sponsors.getCell("R4").value, "Booth Location");
  assert.equal(sponsors.getCell("Q5").value, fixtures[0].boothSize);
  assert.equal(sponsors.getCell("R5").value, fixtures[0].boothLocation);
  assert.ok(!sponsors.getCell("Q6").value);
  assert.ok(!sponsors.getCell("R6").value);
  const attachments = book.getWorksheet("Attachments");
  sections.forEach(([, label, name], index) => {
    assert.equal(attachments.getCell(`B${index + 5}`).value, label);
    assert.equal(attachments.getCell(`C${index + 5}`).value, name);
  });
  assert.ok(!JSON.stringify(book.model).includes("PRIVATE_CONTENT_FIXTURE"));
});

test("Shared PDF prints booth details, readable attachment labels, and legacy missing values", async () => {
  const output = await reports("pdf", fixtures, {});
  const bytes = Buffer.from(output.bytes);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const text = await pdfText(bytes);
  assert.match(text, /Booth Size: 6 x 4 m/);
  assert.match(text, /Booth Location: Hall A - Stand B12/);
  assert.match(text, /Booth Size: Not provided/);
  assert.match(text, /Booth Location: Not provided/);
  for (const [, label, name] of sections)
    assert.ok(text.includes(`${label}: ${name}`));
  assert.ok(!text.includes("PRIVATE_CONTENT_FIXTURE"));
  assert.ok(!text.includes("undefined"));
});

test("Authenticated local exports include saved booth details and attachment metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "maestro-booth-export-"));
  let server;
  try {
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
    const base = await new Promise((resolve, reject) => {
      let output = "",
        errors = "";
      const timeout = setTimeout(
        () => reject(new Error("Booth export test server did not start.")),
        30000,
      );
      server.stderr.on("data", (chunk) => (errors += chunk));
      server.stdout.on("data", (chunk) => {
        output += chunk;
        const port = output.match(/listening on port (\d+)/);
        if (port) {
          clearTimeout(timeout);
          resolve("http://127.0.0.1:" + port[1]);
        }
      });
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Booth export test server exited: ${code} ${errors}`));
      });
    });
    let cookie = "";
    const request = (path, method = "GET", body) => {
      const form = body instanceof FormData;
      return fetch(base + "/api" + path, {
        method,
        headers: {
          "X-Requested-With": "Maestro",
          Cookie: cookie,
          ...(body === undefined || form
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
    };
    const json = async (path, method, body) => {
      const response = await request(path, method, body);
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    };
    assert.equal((await request("/export/excel")).status, 401);
    assert.equal((await request("/export/pdf")).status, 401);
    const setup = await request("/setup", "POST", {
      name: "Booth report administrator",
      email: "booth-report-admin@example.test",
      password: randomBytes(24).toString("hex"),
      token: await readFile(join(dir, "setup-token"), "utf8"),
    });
    assert.equal(setup.status, 201);
    cookie = setup.headers.getSetCookie()[0].split(";")[0];
    const sponsor = await json("/sponsors", "POST", fixtures[0]);
    await json("/sponsors", "POST", fixtures[1]);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
      "base64",
    );
    for (const [kind, , name] of sections) {
      const upload = new FormData();
      upload.append("kind", kind);
      upload.append("files", new Blob([png], { type: "image/png" }), name);
      await json(`/sponsors/${sponsor.id}/attachments`, "POST", upload);
    }
    const excel = await request("/export/excel");
    assert.equal(excel.status, 200);
    const book = await workbook(await excel.arrayBuffer());
    const sponsors = book.getWorksheet("Sponsors");
    assert.equal(sponsors.getCell("P4").value, "Booth Size");
    assert.equal(sponsors.getCell("Q4").value, "Booth Location");
    const row = Array.from({ length: sponsors.rowCount - 4 }, (_, index) =>
      sponsors.getRow(index + 5),
    ).find((item) => item.getCell(1).value === fixtures[0].name);
    assert.equal(row.getCell(16).value, fixtures[0].boothSize);
    assert.equal(row.getCell(17).value, fixtures[0].boothLocation);
    const legacy = Array.from({ length: sponsors.rowCount - 4 }, (_, index) =>
      sponsors.getRow(index + 5),
    ).find((item) => item.getCell(1).value === fixtures[1].name);
    assert.ok(!legacy.getCell(16).value);
    assert.ok(!legacy.getCell(17).value);
    const attachmentRows = [];
    book.getWorksheet("Attachments").eachRow((item, index) => {
      if (index > 1) attachmentRows.push(item.values.slice(1, 4));
    });
    for (const [, label, name] of sections)
      assert.ok(
        attachmentRows.some(
          (item) =>
            item[0] === fixtures[0].name &&
            item[1] === label &&
            item[2] === name,
        ),
      );
    const pdf = await request("/export/pdf");
    assert.equal(pdf.status, 200);
    const text = await pdfText(Buffer.from(await pdf.arrayBuffer()));
    assert.match(text, /Booth Size: 6 x 4 m/);
    assert.match(text, /Booth Location: Hall A - Stand B12/);
    assert.match(text, /Booth Size: Not provided/);
    for (const [, label, name] of sections)
      assert.ok(text.includes(`${label}: ${name}`));
  } finally {
    if (server?.exitCode === null)
      await new Promise((resolve) => {
        server.once("exit", resolve);
        server.kill("SIGTERM");
      });
    await rm(dir, { recursive: true, force: true });
  }
});
