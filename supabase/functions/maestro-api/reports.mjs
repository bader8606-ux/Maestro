import { zipSync, strToU8 } from "fflate";
import { jsPDF } from "jspdf";
import { arabicFont } from "./arabic-font.mjs";
import {
  resolveBrand,
  officialLogo,
  officialFonts,
  decodeAsset,
  fitLogo,
} from "./brand.mjs";
const xml = (s) =>
  String(s ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const hasArabic = (text) =>
  /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/.test(
    String(text),
  );
const amount = (value) => (value == null ? "Not determined" : value);
const money = (n) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
const columns = [
  "Sponsor Name",
  "Sponsorship Package",
  "Contact Person",
  "Mobile Number",
  "Email Address",
  "Approval Status",
  "Approval Date",
  "Purchase Order Issued",
  "Purchase Order Number",
  "Purchase Order Date",
  "Total Sponsorship Value (SAR)",
  "Total Received (SAR)",
  "Outstanding Balance (SAR)",
  "Last Updated",
  "Notes",
  "Consideration",
];
const values = (s) => [
  s.name,
  s.packageName,
  s.contact,
  s.mobile,
  s.email,
  s.approval,
  s.approvalDate,
  s.poIssued ? "Yes" : "No",
  s.poNumber,
  s.poDate,
  amount(s.value),
  s.received,
  amount(s.outstanding),
  s.updatedAt,
  s.notes,
  s.consideration || "",
];
const col = (i) => {
  let s = "";
  for (i++; i; i = Math.floor((i - 1) / 26))
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};
export async function reports(format, sponsors, brand) {
  brand = resolveBrand(brand);
  let logo = null;
  if (brand.logoUrl && !brand.logoIsDefault) {
    const response = await fetch(brand.logoUrl);
    if (response.ok) {
      const type = response.headers.get("content-type");
      if (type === "image/png" || type === "image/jpeg")
        logo = {
          bytes: new Uint8Array(await response.arrayBuffer()),
          ext: type === "image/png" ? "png" : "jpeg",
        };
    }
  }
  logo ||= { bytes: decodeAsset(officialLogo.base64), ext: "png" };
  const logoSize = (width, height) =>
    fitLogo(logo.bytes, "image/" + logo.ext, width, height);
  const total =
    sponsors.reduce(
      (n, s) => n + (s.value == null ? 0 : Math.round(s.value * 100)),
      0,
    ) / 100;
  const received =
    sponsors.reduce((n, s) => n + Math.round(s.received * 100), 0) / 100;
  const outstanding =
    sponsors.reduce(
      (n, s) =>
        n + (s.outstanding == null ? 0 : Math.round(s.outstanding * 100)),
      0,
    ) / 100;
  const unknown = sponsors.filter((s) => s.value == null).length;
  const summary = `Sponsors: ${sponsors.length} | Total Value${unknown ? " (known amounts)" : ""}: SAR ${money(total)} | Total Received: SAR ${money(received)} | Outstanding${unknown ? " (known amounts)" : ""}: SAR ${money(outstanding)}${unknown ? ` | Undetermined values: ${unknown}` : ""}`;
  const sheets = [
    { name: "Sponsors", headers: columns, rows: sponsors.map(values) },
    {
      name: "Payments",
      headers: ["Sponsor Name", "Amount (SAR)", "Payment Date", "Note"],
      rows: sponsors.flatMap((s) =>
        s.payments.map((p) => [s.name, p.amount, p.date, p.note]),
      ),
    },
    {
      name: "Package Benefits",
      headers: [
        "Sponsor Name",
        "Benefit (English)",
        "Benefit (Arabic)",
        "Status",
      ],
      rows: sponsors.flatMap((s) =>
        s.benefits.map((b) => [
          s.name,
          b.title,
          b.titleAr || "",
          b.completed ? "Completed" : "Pending",
        ]),
      ),
    },
    {
      name: "Attachments",
      headers: [
        "Sponsor Name",
        "Section",
        "File Name",
        "File Type",
        "Size (Bytes)",
        "Uploaded At",
      ],
      rows: sponsors.flatMap((s) =>
        s.attachments.map((a) => [
          s.name,
          a.kind === "purchase-order"
            ? "Purchase Order Attachments"
            : a.kind === "approval"
              ? "Approval Attachments"
              : "Sponsor Logo",
          a.name,
          a.mime,
          a.size,
          a.createdAt,
        ]),
      ),
    },
  ];
  if (format === "excel") {
    const files = {};
    const add = (path, value) =>
      (files[path] = typeof value === "string" ? strToU8(value) : value);
    const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    let content =
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    add(
      "_rels/.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    );
    add(
      "xl/workbook.xml",
      `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    );
    add(
      "xl/_rels/workbook.xml.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    );
    add(
      "xl/styles.xml",
      `<styleSheet xmlns="${ns}"><fonts count="3"><font><sz val="11"/><name val="Poppins"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Poppins"/></font><font><sz val="11"/><name val="DejaVu Sans"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${brand.accent.slice(1).toUpperCase()}"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF000000"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" readingOrder="2" wrapText="1"/></xf></cellXfs></styleSheet>`,
    );
    sheets.forEach((s, i) => {
      content += `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
      const rows = [
        ["MAESTRO — Digital Government Forum"],
        ["Sponsor Management Dashboard · Currency: SAR"],
        [summary],
        s.headers,
        ...s.rows,
      ];
      const cells = rows
        .map(
          (r, n) =>
            `<row r="${n + 1}"${n < 3 ? ' ht="28" customHeight="1"' : ""}>${(n < 3 ? Array.from({ length: s.headers.length }, (_, c) => r[c] || "") : r).map((v, c) => (typeof v === "number" ? `<c r="${col(c)}${n + 1}" s="2"><v>${v}</v></c>` : `<c r="${col(c)}${n + 1}" t="inlineStr" s="${n < 3 ? 3 : n === 3 ? 1 : hasArabic(v) ? 4 : 0}"><is><t xml:space="preserve">${xml(v)}</t></is></c>`)).join("")}</row>`,
        )
        .join("");
      add(
        `xl/worksheets/sheet${i + 1}.xml`,
        `<worksheet xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${s.headers.length}" width="27" customWidth="1"/></cols><sheetData>${cells}</sheetData><autoFilter ref="A4:${col(s.headers.length - 1)}${Math.max(4, rows.length)}"/><mergeCells count="3">${[1, 2, 3].map((n) => `<mergeCell ref="A${n}:${col(s.headers.length - 1)}${n}"/>`).join("")}</mergeCells>${logo && i === 0 ? '<drawing r:id="logo"/>' : ""}</worksheet>`,
      );
    });
    if (logo) {
      content += `<Default Extension="${logo.ext}" ContentType="image/${logo.ext}"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
      add(`xl/media/logo.${logo.ext}`, logo.bytes);
      add(
        "xl/worksheets/_rels/sheet1.xml.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="logo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
      );
      add(
        "xl/drawings/_rels/drawing1.xml.rels",
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.${logo.ext}"/></Relationships>`,
      );
      add(
        "xl/drawings/drawing1.xml",
        `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:oneCellAnchor><xdr:from><xdr:col>${sheets[0].headers.length - 2}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>38100</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(logoSize(145, 32).width * 9525)}" cy="${Math.round(logoSize(145, 32).height * 9525)}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="MAESTRO"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="image"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`,
      );
    }
    add(
      "[Content_Types].xml",
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${content}</Types>`,
    );
    return {
      bytes: zipSync(files, { level: 6 }),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  const doc = new jsPDF({ compress: true });
  doc.addFileToVFS("Poppins-Regular.ttf", officialFonts.regular);
  doc.addFont("Poppins-Regular.ttf", "Poppins", "normal");
  doc.addFileToVFS("Poppins-SemiBold.ttf", officialFonts.semibold);
  doc.addFont("Poppins-SemiBold.ttf", "Poppins", "bold");
  if (sponsors.some((s) => hasArabic(JSON.stringify(s)))) {
    doc.addFileToVFS(arabicFont.filename, arabicFont.base64);
    doc.addFont(arabicFont.filename, arabicFont.family, "normal");
  }
  doc.setFont("Poppins", "normal");
  let y = 0;
  const heading = () => {
    doc.setFillColor("#000000");
    doc.rect(0, 0, doc.internal.pageSize.getWidth(), 40, "F");
    doc.setTextColor("#FFFFFF");
    doc.addImage(
      logo.bytes,
      logo.ext === "png" ? "PNG" : "JPEG",
      15,
      9,
      logoSize(48, 12).width,
      logoSize(48, 12).height,
    );
    doc.setFont("Poppins", "normal");
    doc.setFontSize(11);
    doc.text("Digital Government Forum — Sponsor Management Dashboard", 15, 26);
    doc.setFontSize(10);
    doc.text("Currency: SAR", 15, 34);
    doc.setFillColor(brand.accent);
    doc.rect(0, 40, doc.internal.pageSize.getWidth(), 1, "F");
    doc.setTextColor("#222222");
    y = 49;
  };
  const line = (text, { rtl = false } = {}) => {
    const currentFont = doc.getFont();
    const fontSize = doc.getFontSize();
    const family = hasArabic(text) ? arabicFont.family : currentFont.fontName;
    const style = hasArabic(text) ? "normal" : currentFont.fontStyle;
    doc.setFont(family, style);
    const lines = doc.splitTextToSize(String(text), 178);
    for (const l of lines) {
      if (y > 275) {
        doc.addPage();
        heading();
        doc.setFont(family, style);
        doc.setFontSize(fontSize);
      }
      doc.text(l, rtl ? 193 : 15, y, {
        align: rtl ? "right" : "left",
        isInputVisual: false,
        isInputRtl: rtl,
        isOutputVisual: true,
        isOutputRtl: false,
        isSymmetricSwapping: true,
      });
      y += 6;
    }
    doc.setFont(currentFont.fontName, currentFont.fontStyle);
    doc.setFontSize(fontSize);
  };
  heading();
  line(summary);
  line(`Generated: ${new Date().toISOString()}`);
  for (const s of sponsors) {
    doc.addPage();
    heading();
    doc.setFont("Poppins", "bold");
    doc.setFontSize(14);
    line(s.name);
    doc.setFont("Poppins", "normal");
    doc.setFontSize(10);
    columns.forEach((c, i) =>
      line(
        `${c}: ${typeof values(s)[i] === "number" ? money(values(s)[i]) : values(s)[i] || "Not provided"}`,
      ),
    );
    line("Payments Received");
    if (!s.payments.length) line("No payments recorded.");
    s.payments.forEach((p) =>
      line(`SAR ${money(p.amount)} | ${p.date} | ${p.note}`),
    );
    line("Package Benefits — English");
    if (!s.benefits.length) line("No benefits recorded.");
    s.benefits.forEach((b, index) =>
      line(
        `${index + 1}. ${b.completed ? "Completed" : "Pending"}: ${b.title}`,
      ),
    );
    line("Package Benefits — Arabic");
    if (!s.benefits.some((b) => b.titleAr))
      line("No Arabic benefits recorded.");
    else
      s.benefits.forEach((b, index) => {
        line(`Benefit ${index + 1} — ${b.completed ? "Completed" : "Pending"}`);
        if (b.titleAr) line(b.titleAr, { rtl: true });
        else line("Arabic text not provided.");
      });
    line("Attachments");
    s.attachments.forEach((a) => line(`${a.kind}: ${a.name}`));
  }
  return {
    bytes: new Uint8Array(doc.output("arraybuffer")),
    mime: "application/pdf",
  };
}
