import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { reports } from "../supabase/functions/maestro-api/reports.mjs";

const common = {
  packageName: "Fixture package",
  contact: "",
  mobile: "",
  email: "",
  approval: "Not Approved",
  approvalDate: "",
  poIssued: false,
  poNumber: "",
  poDate: "",
  updatedAt: "2026-10-06T00:00:00.000Z",
  notes: "",
  attachments: [],
};
const arabic = "المزايا الفضية بدون المعرض وبدون الوقت على المسرح";
const sponsors = [
  {
    ...common,
    name: "Known amount fixture",
    value: 100,
    received: 25,
    outstanding: 75,
    payments: [{ amount: 25, date: "2026-10-06", note: "" }],
    benefits: [
      {
        title: "Lanyard exclusivity",
        titleAr: "حصرية اللانيارد وشعار LED ورقم 123",
        completed: true,
      },
    ],
  },
  {
    ...common,
    name: "Undetermined amount fixture",
    value: null,
    received: 10,
    outstanding: null,
    consideration: "Media services; scope is being defined.",
    payments: [{ amount: 10, date: "2026-10-06", note: "" }],
    benefits: [
      {
        title: "Silver benefits excluding exhibition and stage time",
        titleAr: arabic,
        completed: false,
      },
      { title: "Existing English-only benefit", completed: false },
    ],
  },
];

test("Excel keeps Arabic benefits and undetermined values distinct from zero", async () => {
  const output = await reports("excel", sponsors, {});
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(output.bytes));
  const summary = workbook.getWorksheet("Sponsors");
  assert.equal(summary.getCell("K5").value, 100);
  assert.equal(summary.getCell("M5").value, 75);
  assert.equal(summary.getCell("K6").value, "Not determined");
  assert.equal(summary.getCell("M6").value, "Not determined");
  assert.equal(summary.getCell("P4").value, "Consideration");
  assert.equal(summary.getCell("P6").value, sponsors[1].consideration);
  assert.match(
    summary.getCell("A3").value,
    /Total Value \(known amounts\): SAR 100\.00/,
  );
  assert.match(summary.getCell("A3").value, /Total Received: SAR 35\.00/);
  assert.match(
    summary.getCell("A3").value,
    /Outstanding \(known amounts\): SAR 75\.00/,
  );
  assert.match(summary.getCell("A3").value, /Undetermined values: 1/);
  const benefits = workbook.getWorksheet("Package Benefits");
  assert.deepEqual(benefits.getRow(4).values.slice(1), [
    "Sponsor Name",
    "Benefit (English)",
    "Benefit (Arabic)",
    "Status",
  ]);
  assert.equal(benefits.getCell("B6").value, sponsors[1].benefits[0].title);
  assert.equal(benefits.getCell("C6").value, arabic);
  assert.equal(benefits.getCell("D6").value, "Pending");
  assert.equal(benefits.getCell("C6").alignment.readingOrder, "rtl");
  assert.equal(benefits.getCell("C6").font.name, "DejaVu Sans");
  assert.ok(!benefits.getCell("C7").value);
});

test("PDF embeds Arabic glyphs and prints separate language sections and unknown values", async (t) => {
  const output = await reports("pdf", sponsors, {});
  const bytes = Buffer.from(output.bytes);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const pdf = bytes.toString("latin1");
  assert.match(pdf, /\/BaseFont \/Poppins/);
  assert.match(pdf, /\/BaseFont \/DejaVuSans/);
  assert.match(pdf, /\/FontFile2/);
  const dir = await mkdtemp(join(tmpdir(), "maestro-bilingual-report-"));
  try {
    const path = join(dir, "report.pdf");
    await writeFile(path, bytes);
    let text;
    try {
      ({ stdout: text } = await promisify(execFile)("pdftotext", [
        "-layout",
        path,
        "-",
      ]));
    } catch (error) {
      if (error.code === "ENOENT") {
        t.diagnostic(
          "pdftotext is unavailable; PDF structure and embedded-font assertions passed.",
        );
        return;
      }
      throw error;
    }
    text = text.normalize("NFKC").replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
    assert.match(text, /Package Benefits — English/);
    assert.match(text, /Package Benefits — Arabic/);
    assert.match(text, /Total Sponsorship Value \(SAR\): Not determined/);
    assert.match(text, /Outstanding Balance \(SAR\): Not determined/);
    assert.match(text, /Media services; scope is being defined\./);
    assert.ok(
      text.includes(arabic),
      "Arabic benefits remain readable and extractable.",
    );
    assert.match(text, /LED/);
    assert.match(text, /123/);
    assert.match(text, /Total Received: SAR 35\.00/);
    assert.match(text, /Outstanding\s+\(known amounts\): SAR 75\.00/);
    assert.ok(!text.includes("NaN"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
