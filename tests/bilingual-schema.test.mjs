import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import {
  sponsorSchema,
  packageSchema,
} from "../supabase/functions/maestro-api/validation.mjs";

const input = () => ({
  name: "Bilingual schema fixture",
  packageId: "",
  contact: "",
  mobile: "",
  email: "",
  approval: "Not Approved",
  approvalDate: "",
  poIssued: false,
  poNumber: "",
  poDate: "",
  value: 100.1,
  payments: [],
  benefits: [
    { id: randomUUID(), title: "Lanyard exclusivity", completed: false },
  ],
  notes: "",
});

test("Cloud schema preserves bilingual benefits and unknown in-kind amounts without changing legacy fields", () => {
  const legacy = input();
  assert.deepEqual(sponsorSchema.parse(legacy), legacy);
  const translated = {
    ...legacy,
    value: null,
    consideration: " In-kind media services; scope being defined. ",
    benefits: [{ ...legacy.benefits[0], titleAr: " حصرية اللانيارد " }],
  };
  const result = sponsorSchema.parse(translated);
  assert.equal(result.value, null);
  assert.equal(
    result.consideration,
    "In-kind media services; scope being defined.",
  );
  assert.deepEqual(result.benefits[0], {
    ...legacy.benefits[0],
    titleAr: "حصرية اللانيارد",
  });
  assert.equal(
    sponsorSchema.safeParse({ ...legacy, consideration: "x".repeat(1001) })
      .success,
    false,
  );
  assert.equal(
    sponsorSchema.safeParse({
      ...legacy,
      benefits: [{ ...legacy.benefits[0], title: "", titleAr: "ميزة" }],
    }).success,
    false,
  );
  assert.equal(
    sponsorSchema.safeParse({
      ...legacy,
      benefits: [{ ...legacy.benefits[0], titleAr: "أ".repeat(301) }],
    }).success,
    false,
  );
  for (const value of [-1, 0.001, "100", Number.NaN, Number.POSITIVE_INFINITY])
    assert.equal(sponsorSchema.safeParse({ ...legacy, value }).success, false);
});

test("Cloud package schema keeps translations aligned with their English benefit", () => {
  const legacy = {
    name: "Bilingual package fixture",
    benefits: ["Visibility", "Speaking time"],
  };
  assert.deepEqual(packageSchema.parse(legacy), legacy);
  assert.deepEqual(
    packageSchema.parse({ ...legacy, benefitsAr: [] }).benefitsAr,
    [],
  );
  assert.deepEqual(
    packageSchema.parse({ ...legacy, benefitsAr: [" الظهور ", ""] }).benefitsAr,
    ["الظهور", ""],
  );
  assert.equal(
    packageSchema.safeParse({ ...legacy, benefitsAr: ["الظهور"] }).success,
    false,
  );
  assert.equal(
    packageSchema.safeParse({
      ...legacy,
      benefitsAr: ["الظهور", "وقت على المسرح", "إضافة"],
    }).success,
    false,
  );
  assert.equal(
    packageSchema.safeParse({ ...legacy, benefitsAr: ["أ".repeat(301), ""] })
      .success,
    false,
  );
});

test("Local API persists both benefit languages and distinguishes unknown consideration from cash sponsorship", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "maestro-bilingual-api-"));
  let server,
    base,
    cookie = "";
  const start = async () => {
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
      let output = "",
        errors = "";
      const timeout = setTimeout(
        () => reject(new Error("Bilingual test server did not start.")),
        30000,
      );
      server.stderr.on("data", (chunk) => {
        errors += chunk;
      });
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
        reject(
          new Error("Bilingual test server exited: " + code + " " + errors),
        );
      });
    });
  };
  const stop = async () => {
    if (server?.exitCode === null)
      await new Promise((resolve) => {
        server.once("exit", resolve);
        server.kill("SIGTERM");
      });
  };
  const request = (path, method = "GET", body) =>
    fetch(base + "/api" + path, {
      method,
      headers: {
        "X-Requested-With": "Maestro",
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (path, method, body) => {
    const response = await request(path, method, body);
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  try {
    await start();
    const setup = await request("/setup", "POST", {
      name: "Bilingual fixture administrator",
      email: "bilingual-admin@example.test",
      password: randomBytes(24).toString("hex"),
      token: await readFile(join(dir, "setup-token"), "utf8"),
    });
    assert.equal(setup.status, 201);
    cookie = setup.headers.getSetCookie()[0].split(";")[0];
    const packageInput = {
      name: "Bilingual fixture package",
      benefits: ["Lanyard exclusivity"],
      benefitsAr: ["حصرية اللانيارد"],
    };
    const pkg = await json("/packages", "POST", packageInput);
    assert.deepEqual(pkg.benefitsAr, packageInput.benefitsAr);
    assert.equal(
      (
        await request("/packages", "POST", {
          ...packageInput,
          benefitsAr: ["ميزة", "إضافة"],
        })
      ).status,
      400,
    );
    const legacy = await json("/sponsors", "POST", input());
    assert.equal(legacy.outstanding, 100.1);
    assert.equal(Object.hasOwn(legacy.benefits[0], "titleAr"), false);
    const payment = {
      id: randomUUID(),
      amount: 17.01,
      date: "2026-10-06",
      note: "Actual payment fixture",
    };
    let inKind = await json("/sponsors", "POST", {
      ...input(),
      name: "Unknown consideration fixture",
      packageId: pkg.id,
      value: null,
      consideration: "In-kind media services; scope being defined.",
      poIssued: true,
      payments: [payment],
      benefits: [
        {
          id: randomUUID(),
          title: pkg.benefits[0],
          titleAr: pkg.benefitsAr[0],
          completed: false,
        },
      ],
    });
    assert.equal(inKind.value, null);
    assert.equal(inKind.outstanding, null);
    assert.equal(inKind.received, 17.01);
    assert.equal(inKind.approval, "Not Approved");
    assert.equal(inKind.poIssued, true);
    const benefitId = inKind.benefits[0].id;
    inKind = await json("/sponsors/" + inKind.id, "PUT", {
      ...inKind,
      benefits: [
        {
          ...inKind.benefits[0],
          titleAr: "الحصرية على اللانيارد",
          completed: true,
        },
      ],
    });
    assert.deepEqual(inKind.benefits[0], {
      id: benefitId,
      title: "Lanyard exclusivity",
      titleAr: "الحصرية على اللانيارد",
      completed: true,
    });
    assert.equal(inKind.outstanding, null);
    const cash = await json("/sponsors", "POST", {
      ...input(),
      name: "Cash fixture",
      payments: [{ ...payment, id: randomUUID(), amount: 25.05 }],
    });
    assert.equal(cash.outstanding, 75.05);
    await stop();
    await start();
    const restored = await json("/sponsors/" + inKind.id);
    assert.equal(restored.value, null);
    assert.equal(restored.outstanding, null);
    assert.equal(restored.received, payment.amount);
    assert.equal(restored.consideration, inKind.consideration);
    assert.deepEqual(restored.benefits, inKind.benefits);
    assert.deepEqual((await json("/packages"))[0].benefitsAr, pkg.benefitsAr);

    const excel = await request("/export/excel");
    assert.equal(excel.status, 200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await excel.arrayBuffer()));
    const sponsors = book.getWorksheet("Sponsors");
    const row = sponsors
      .getRows(5, sponsors.rowCount - 4)
      .find((r) => r.getCell(1).value === inKind.name);
    assert.equal(row.getCell(11).value, "Not determined");
    assert.equal(row.getCell(13).value, "Not determined");
    assert.equal(row.getCell(15).value, inKind.consideration);
    const benefits = book.getWorksheet("Package Benefits");
    assert.deepEqual(benefits.getRow(1).values.slice(1), [
      "Sponsor Name",
      "Benefit (English)",
      "Benefit (Arabic)",
      "Status",
    ]);
    const benefitRow = benefits
      .getRows(2, benefits.rowCount - 1)
      .find((r) => r.getCell(1).value === inKind.name);
    assert.equal(benefitRow.getCell(2).value, inKind.benefits[0].title);
    assert.equal(benefitRow.getCell(3).value, inKind.benefits[0].titleAr);
    assert.equal(benefitRow.getCell(4).value, "Completed");
    const pdf = await request("/export/pdf");
    assert.equal(pdf.status, 200);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    assert.ok(
      bytes.toString("latin1").includes("DejaVuSans"),
      "Arabic fallback font is embedded for Arabic benefits.",
    );
    const reportPath = join(dir, "bilingual-report.pdf");
    await writeFile(reportPath, bytes);
    try {
      const { stdout } = await promisify(execFile)("pdftotext", [
        "-layout",
        reportPath,
        "-",
      ]);
      const text = stdout
        .normalize("NFKC")
        .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
      assert.ok(
        text.includes(restored.benefits[0].titleAr),
        "Saved Arabic benefits are readable in the actual API PDF.",
      );
      assert.ok(text.includes(restored.benefits[0].title));
      assert.ok(text.includes(restored.consideration));
      assert.match(text, /Total Sponsorship Value \(SAR\): Not determined/);
      assert.match(text, /Outstanding Balance \(SAR\): Not determined/);
      assert.match(text, /Total Received: SAR 42\.06/);
      assert.match(text, /Outstanding\s+\(known amounts\): SAR 175\.15/);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      t.diagnostic(
        "pdftotext is unavailable; actual PDF structure and embedded-font assertions passed.",
      );
    }
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
