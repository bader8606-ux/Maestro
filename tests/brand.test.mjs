import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { reports } from "../supabase/functions/maestro-api/reports.mjs";

test("Cloud reports embed the original identity offline and preserve custom brand choices", async () => {
  const brand = {
    organization: "MAESTRO",
    accent: "#536b62",
    configured: false,
    logoIsDefault: true,
  };
  const originalLogo = await readFile("public/brand/maestro-logo.png");
  const output = await reports("excel", [], brand);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(output.bytes));
  const sheet = workbook.getWorksheet("Sponsors");
  assert.equal(sheet.rowCount, 4);
  assert.equal(sheet.getCell("A4").fill.fgColor.argb, "FF0078B5");
  assert.equal(sheet.getCell("A1").fill.fgColor.argb, "FF000000");
  assert.equal(sheet.getCell("A4").font.name, "Poppins");
  assert.deepEqual(Buffer.from(workbook.model.media[0].buffer), originalLogo);
  const logo = sheet.getImages()[0];
  assert.ok(
    Math.abs(logo.range.ext.width / logo.range.ext.height - 2400 / 474) <
      0.00001,
  );
  const pdf = await reports("pdf", [], brand);
  assert.equal(Buffer.from(pdf.bytes).subarray(0, 5).toString(), "%PDF-");
  assert.ok(
    Buffer.from(pdf.bytes).toString("latin1").includes("/BaseFont /Poppins"),
    "PDF names the supplied Poppins font.",
  );
  assert.ok(
    Buffer.from(pdf.bytes).toString("latin1").includes("/FontFile2"),
    "PDF embeds TrueType font bytes.",
  );

  const uploadedLogo = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
    "base64",
  );
  const custom = await reports("excel", [], {
    configured: true,
    accent: "#112233",
    logoIsDefault: false,
    logoUrl: "data:image/png;base64," + uploadedLogo.toString("base64"),
  });
  const customWorkbook = new ExcelJS.Workbook();
  await customWorkbook.xlsx.load(Buffer.from(custom.bytes));
  assert.equal(
    customWorkbook.getWorksheet("Sponsors").getCell("A4").fill.fgColor.argb,
    "FF112233",
  );
  assert.deepEqual(
    Buffer.from(customWorkbook.model.media[0].buffer),
    uploadedLogo,
  );
});
