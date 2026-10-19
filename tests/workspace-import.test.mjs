import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { DOCX_MIME } from "../supabase/functions/maestro-api/document-files.mjs";
import {
  createImportKey,
  decryptEnvelope,
  encryptEnvelope,
  imageBytes,
  mergeBenefits,
  planImport,
  transactionSql,
  validatePayload,
  validateStagePayload,
  buildQuotationStages,
  assembleQuotationFiles,
  stageSql,
  quotationBytes,
  verifyStoredQuotation,
  buildContractStages,
  assembleContractFiles,
  contractBytes,
  verifyStoredContract,
} from "../scripts/workspace-import.mjs";
import { publicImportKey } from "../supabase/functions/maestro-api/import-key.mjs";
import { createHandler } from "../supabase/functions/maestro-api/handler.mjs";

const projectRef = "abcdefghijklmnopqrst";
const key = createImportKey();
const fixture = () => ({
  version: 1,
  projectRef,
  operationId: randomUUID(),
  sponsors: [
    {
      name: "Encrypted fixture company",
      packageName: "Fixture main partner",
      packageBenefits: ["Main entrance visibility"],
      packageBenefitsAr: ["الظهور عند المدخل الرئيسي"],
      value: 999.99,
      consideration: "",
      benefits: [
        {
          title: "Main entrance visibility",
          titleAr: "الظهور عند المدخل الرئيسي",
        },
      ],
    },
  ],
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
  "base64",
);
const logo = () => ({
  name: "fixture-logo.png",
  mime: "image/png",
  base64: png.toString("base64"),
});
const emptyState = () => ({ packages: [], sponsors: [], attachments: [] });
const db = (row, error = null) => ({
  storage: { from: () => ({}) },
  from: (table) => {
    assert.equal(table, "maestro_settings");
    return {
      select: (fields) => {
        assert.equal(fields, "data");
        return {
          eq: (field, value) => {
            assert.equal(field, "id");
            assert.equal(value, "import-key");
            return { maybeSingle: async () => ({ data: row, error }) };
          },
        };
      },
    };
  },
});

const quotationFixture = (size = 213885) => {
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    randomBytes(size - 9),
  ]);
  const operationId = randomUUID();
  const name = "Encrypted fixture company";
  const built = buildQuotationStages({
    projectRef,
    operationId,
    sponsorName: name,
    fileName: "Original quotation.pdf",
    bytes,
  });
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId,
      sponsors: [{ name, quotations: [built.quotation] }],
    },
    projectRef,
  );
  const rows = built.stages.map((s) => ({
    data: { ...s, keyId: key.keyId, expiresAt: key.expiresAt },
  }));
  return { ...built, bytes, payload, rows };
};

test("Original PDFs cross bounded authenticated chunks without changing bytes or exposing file names", () => {
  const { quotation, stages, bytes, payload, rows } = quotationFixture();
  assert.equal(stages.length, 7);
  assert.equal(quotation.size, bytes.length);
  assert.equal(
    quotation.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  for (const stage of stages) {
    const envelope = encryptEnvelope(stage, key);
    assert.ok(
      envelope.length < 60000,
      `Encrypted chunk length ${envelope.length}`,
    );
    assert.equal(envelope.includes(quotation.name), false);
    assert.deepEqual(decryptEnvelope(envelope, key, projectRef), stage);
  }
  assert.deepEqual(
    decryptEnvelope(encryptEnvelope(payload, key), key, projectRef),
    payload,
  );
  assert.ok(
    assembleQuotationFiles(payload, [...rows].reverse(), key)
      .get(quotation.fileId)
      .equals(bytes),
  );
  const longNames = structuredClone(stages[0]);
  longNames.stage.name = "q".repeat(236) + ".pdf";
  longNames.stage.sponsorName = "s".repeat(200);
  assert.ok(encryptEnvelope(longNames, key).length < 60000);
});

test("Quotation assembly refuses missing, repeated, corrupt, expired and cross-owner/project/operation stages", () => {
  const { rows, payload } = quotationFixture();
  assert.throws(
    () => assembleQuotationFiles(payload, rows.slice(1), key),
    /incomplete/,
  );
  assert.throws(
    () => assembleQuotationFiles(payload, [...rows.slice(1), rows[1]], key),
    /ownership/,
  );
  for (const mutate of [
    (r) => {
      r.data.keyId = randomUUID();
    },
    (r) => {
      r.data.expiresAt = new Date(0).toISOString();
    },
    (r) => {
      r.data.stage.sponsorName = "Another sponsor";
    },
    (r) => {
      r.data.stage.name = "Another file.pdf";
    },
    (r) => {
      r.data.projectRef = "zyxwvutsrqponmlkjihgf";
    },
    (r) => {
      r.data.operationId = randomUUID();
    },
    (r) => {
      const b = Buffer.from(r.data.stage.base64, "base64");
      b[200] ^= 1;
      r.data.stage.base64 = b.toString("base64");
    },
  ]) {
    const changed = structuredClone(rows);
    mutate(changed[0]);
    assert.throws(() => assembleQuotationFiles(payload, changed, key));
  }
  const short = structuredClone(rows[0].data);
  delete short.keyId;
  delete short.expiresAt;
  short.stage.base64 = "YQ==";
  assert.throws(() => validateStagePayload(short, projectRef), /chunk/);
});

test("Only original bounded PDF quotation descriptors are accepted, with safe filenames and unique file identities", () => {
  const { payload, bytes, quotation } = quotationFixture(1000);
  assert.ok(quotationBytes(bytes, quotation).equals(bytes));
  assert.throws(
    () => quotationBytes(Buffer.from("%PDF-false"), quotation),
    /checksum/,
  );
  assert.throws(
    () =>
      buildQuotationStages({
        projectRef,
        operationId: randomUUID(),
        sponsorName: "Fixture",
        fileName: "x.pdf",
        bytes: Buffer.from("image"),
      }),
    /signature/,
  );
  for (const change of [
    { name: "../quote.pdf" },
    { name: "file\n.pdf" },
    { name: "quote.png" },
    { mime: "image/png" },
    { kind: "approval" },
    { size: 10 * 1024 * 1024 + 1 },
  ]) {
    const altered = structuredClone(payload);
    Object.assign(altered.sponsors[0].quotations[0], change);
    assert.throws(() => validatePayload(altered, projectRef), /schema/);
  }
  const repeated = structuredClone(payload);
  repeated.sponsors[0].quotations.push(quotation);
  assert.throws(
    () => validatePayload(repeated, projectRef),
    /duplicate quotation/,
  );
});

test("Quotation staging SQL verifies immutable chunks and current keys without touching business records", () => {
  const { stages } = quotationFixture(1000);
  stages[0].stage.name = "Original '$quotation_stage$ file.pdf";
  const sql = stageSql(stages[0], key);
  assert.match(sql, /lock table public\.maestro_settings/);
  assert.match(sql, /Quotation stage conflict/);
  assert.match(sql, /Quotation staging key expired/);
  assert.match(sql, /select true as verified/);
  assert.equal(sql.includes("maestro_sponsors"), false);
  const delimiter = sql.match(/do (\$stage_[a-f0-9]+\$)/)[1];
  assert.equal(sql.split(delimiter).length, 3);
  assert.throws(
    () => stageSql(stages[0], { ...key, expiresAt: new Date(0).toISOString() }),
    /current/,
  );
});

test("Quotation-only planning preserves complete sponsor data and separates files from approval, PO and logos", () => {
  const { payload, rows, quotation, bytes } = quotationFixture(1000);
  const seed = planImport(fixture(), emptyState());
  const previous = { ...seed.sponsors[0], revision: 8 };
  previous.data.approval = "Approved";
  previous.data.poIssued = true;
  previous.data.payments = [
    { id: randomUUID(), amount: 50, date: "2026-10-01", note: "Receipt" },
  ];
  const approval = {
    id: randomUUID(),
    sponsor_id: previous.id,
    kind: "approval",
    path: "approval",
  };
  const otherOwner = {
    id: randomUUID(),
    sponsor_id: randomUUID(),
    kind: "quotation",
    path: "other-owner",
    sha256: quotation.sha256,
  };
  const state = {
    packages: seed.packages,
    sponsors: [previous],
    attachments: [approval, otherOwner],
    quotationFiles: assembleQuotationFiles(payload, rows, key),
  };
  const plan = planImport(payload, state);
  assert.deepEqual(plan.sponsors[0].data, previous.data);
  assert.equal(plan.sponsors[0].changed, false);
  assert.equal(plan.sponsors[0].package_id, previous.package_id);
  assert.equal(plan.packages.length, 0);
  assert.equal(plan.logos.length, 0);
  assert.equal(plan.quotations.length, 1);
  assert.equal(plan.quotations[0].sponsor_id, previous.id);
  assert.equal(plan.quotations[0].kind, "quotation");
  assert.equal(plan.quotations[0].name, quotation.name);
  assert.ok(plan.quotations[0].bytes.equals(bytes));
  assert.equal(plan.summary.quotationsAdded, 1);
  const existing = { ...plan.quotations[0] };
  delete existing.bytes;
  const repeated = planImport(payload, {
    ...state,
    attachments: [...state.attachments, existing],
  });
  assert.equal(repeated.quotations.length, 0);
  assert.equal(repeated.summary.quotationsPreserved, 1);
  assert.throws(
    () => planImport(payload, { ...state, sponsors: [] }),
    /existing sponsor/,
  );
  assert.throws(
    () =>
      planImport(payload, {
        ...state,
        sponsors: [previous, { ...previous, id: randomUUID() }],
      }),
    /ambiguous/,
  );
  assert.throws(
    () => planImport(payload, { ...state, quotationFiles: new Map() }),
    /signature|checksum/,
  );
  const sql = transactionSql(plan, payload, "f".repeat(64));
  assert.match(sql, /kind='quotation'/);
  assert.match(sql, /Quotation import conflict/);
  assert.match(sql, /revision=8/);
  assert.match(sql, /Import verification failed/);
  assert.match(
    sql,
    /delete from public\.maestro_settings where id like 'import-stage:/,
  );
});

test("Private quotation readback checks exact original bytes before attachment commit", async () => {
  const { bytes, quotation } = quotationFixture(1000);
  const good = {
    download: async () => ({ data: new Blob([bytes]), error: null }),
  };
  assert.ok(
    (
      await verifyStoredQuotation(good, {
        ...quotation,
        path: "private-original",
      })
    ).equals(bytes),
  );
  const corrupt = Buffer.from(bytes);
  corrupt[50] ^= 1;
  await assert.rejects(
    verifyStoredQuotation(
      { download: async () => ({ data: new Blob([corrupt]) }) },
      quotation,
    ),
    /checksum/,
  );
  await assert.rejects(
    verifyStoredQuotation(
      { download: async () => ({ error: new Error("not printed") }) },
      quotation,
    ),
    /could not be verified/,
  );
});

const docxFixtureBytes = () =>
  Buffer.from(
    zipSync(
      {
        "[Content_Types].xml": strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        "_rels/.rels": strToU8(
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        ),
        "word/document.xml": strToU8(
          '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Disposable contract fixture</w:t></w:r></w:p></w:body></w:document>',
        ),
        "word/media/disposable.bin": randomBytes(100000),
      },
      { level: 6 },
    ),
  );
const contractFixture = (
  bytes = docxFixtureBytes(),
  fileName = "اتفاقية رعاية تجريبية - 2026.docx",
) => {
  const operationId = randomUUID(),
    name = "Encrypted fixture company";
  const built = buildContractStages({
    projectRef,
    operationId,
    sponsorName: name,
    fileName,
    bytes,
  });
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId,
      sponsors: [{ name, contracts: [built.contract] }],
    },
    projectRef,
  );
  const rows = built.stages.map((s) => ({
    data: { ...s, keyId: key.keyId, expiresAt: key.expiresAt },
  }));
  return { ...built, bytes, payload, rows };
};

test("Original DOCX contracts retain Arabic filenames, exact bytes and explicit destination across bounded authenticated stages", () => {
  const { contract, stages, bytes, payload, rows } = contractFixture();
  assert.equal(contract.mime, DOCX_MIME);
  assert.equal(contract.name, "اتفاقية رعاية تجريبية - 2026.docx");
  assert.ok(stages.length > 1);
  for (const stage of stages) {
    assert.equal(stage.stage.kind, "contract");
    const envelope = encryptEnvelope(stage, key);
    assert.ok(envelope.length < 60000);
    assert.equal(envelope.includes(contract.name), false);
    assert.deepEqual(decryptEnvelope(envelope, key, projectRef), stage);
  }
  assert.ok(
    assembleContractFiles(payload, [...rows].reverse(), key)
      .get(contract.fileId)
      .equals(bytes),
  );
  assert.deepEqual(
    decryptEnvelope(encryptEnvelope(payload, key), key, projectRef),
    payload,
  );
  const pdf = contractFixture(
    quotationFixture(1000).bytes,
    "Original contract.pdf",
  );
  assert.equal(pdf.contract.mime, "application/pdf");
  assert.ok(
    assembleContractFiles(pdf.payload, pdf.rows, key)
      .get(pdf.contract.fileId)
      .equals(pdf.bytes),
  );
});

test("Contract validation rejects ZIP spoofing, unsafe names, type mismatch, missing and corrupt stages, expiry and cross-owner metadata", () => {
  const { contract, payload, rows, bytes } = contractFixture();
  const spoof = Buffer.from(
    zipSync({ "word/document.xml": strToU8("not a genuine OOXML package") }),
  );
  assert.throws(() =>
    buildContractStages({
      projectRef,
      operationId: randomUUID(),
      sponsorName: "Fixture",
      fileName: "spoof.docx",
      bytes: spoof,
    }),
  );
  assert.throws(
    () => contractBytes(bytes, { ...contract, mime: "application/pdf" }),
    /signature/,
  );
  assert.throws(
    () => contractBytes(Buffer.from("PK fake"), { ...contract, size: 7 }),
    /checksum/,
  );
  for (const change of [
    { name: "../contract.docx" },
    { name: "bad\n.docx" },
    { name: "contract.docm" },
    { name: "contract.pdf" },
    { mime: "application/zip" },
    { kind: "approval" },
    { size: 10 * 1024 * 1024 + 1 },
  ]) {
    const altered = structuredClone(payload);
    Object.assign(altered.sponsors[0].contracts[0], change);
    assert.throws(() => validatePayload(altered, projectRef));
  }
  assert.throws(
    () => assembleContractFiles(payload, rows.slice(1), key),
    /incomplete/,
  );
  assert.throws(
    () => assembleContractFiles(payload, [...rows.slice(1), rows[1]], key),
    /ownership/,
  );
  for (const mutate of [
    (r) => {
      r.data.keyId = randomUUID();
    },
    (r) => {
      r.data.expiresAt = new Date(0).toISOString();
    },
    (r) => {
      r.data.stage.sponsorName = "Another sponsor";
    },
    (r) => {
      r.data.stage.name = "Another file.docx";
    },
    (r) => {
      r.data.projectRef = "zyxwvutsrqponmlkjihgf";
    },
    (r) => {
      r.data.operationId = randomUUID();
    },
    (r) => {
      const b = Buffer.from(r.data.stage.base64, "base64");
      b[100] ^= 1;
      r.data.stage.base64 = b.toString("base64");
    },
  ]) {
    const changed = structuredClone(rows);
    mutate(changed[0]);
    assert.throws(() => assembleContractFiles(payload, changed, key));
  }
});

test("Authenticated staging binds quotation and contract destinations even when a PDF descriptor is otherwise identical", () => {
  const quoted = quotationFixture(1000);
  const relabeledContract = validatePayload(
    {
      ...quoted.payload,
      sponsors: [
        {
          name: quoted.payload.sponsors[0].name,
          contracts: quoted.payload.sponsors[0].quotations,
        },
      ],
    },
    projectRef,
  );
  assert.throws(
    () => assembleContractFiles(relabeledContract, quoted.rows, key),
    /kind/,
  );
  const signed = contractFixture(quoted.bytes, "Original contract.pdf");
  const relabeledQuotation = validatePayload(
    {
      ...signed.payload,
      sponsors: [
        {
          name: signed.payload.sponsors[0].name,
          quotations: signed.payload.sponsors[0].contracts,
        },
      ],
    },
    projectRef,
  );
  assert.throws(
    () => assembleQuotationFiles(relabeledQuotation, signed.rows, key),
    /kind/,
  );
  const missingKind = structuredClone(contractFixture().rows[0].data);
  delete missingKind.keyId;
  delete missingKind.expiresAt;
  delete missingKind.stage.kind;
  assert.throws(() => validateStagePayload(missingKind, projectRef));
  const duplicate = structuredClone(signed.payload);
  duplicate.sponsors.push({
    name: "Another sponsor",
    quotations: [signed.contract],
  });
  assert.throws(() => validatePayload(duplicate, projectRef), /duplicate/);
  const sql = stageSql(signed.stages[0], key);
  assert.match(sql, /\"kind\":\"contract\"/);
  assert.match(sql, /stage conflict/);
  assert.equal(sql.includes("maestro_sponsors"), false);
});

test("Contract-only planning preserves sponsor fields, separates owners and kinds, deduplicates content and atomically cleans stages", () => {
  const { payload, rows, contract, bytes } = contractFixture();
  const seed = planImport(fixture(), emptyState());
  const previous = { ...seed.sponsors[0], revision: 8 };
  previous.data.approval = "Approved";
  previous.data.poIssued = true;
  previous.data.notesAr = "ملاحظات لا تتغير";
  previous.data.payments = [
    { id: randomUUID(), amount: 50, date: "2026-10-01", note: "Receipt" },
  ];
  const originalFields = structuredClone(previous.data);
  const otherOwner = {
    id: randomUUID(),
    sponsor_id: randomUUID(),
    kind: "contract",
    path: "other-owner",
    sha256: contract.sha256,
  };
  const otherKind = {
    id: randomUUID(),
    sponsor_id: previous.id,
    kind: "quotation",
    path: "other-kind",
    sha256: contract.sha256,
  };
  const state = {
    packages: seed.packages,
    sponsors: [previous],
    attachments: [otherOwner, otherKind],
    contractFiles: assembleContractFiles(payload, rows, key),
  };
  const plan = planImport(payload, state);
  assert.deepEqual(plan.sponsors[0].data, originalFields);
  assert.equal(plan.sponsors[0].changed, false);
  assert.equal(plan.sponsors[0].package_id, previous.package_id);
  assert.equal(plan.packages.length, 0);
  assert.equal(plan.quotations.length, 0);
  assert.equal(plan.logos.length, 0);
  assert.equal(plan.contracts.length, 1);
  assert.equal(plan.summary.contractsAdded, 1);
  assert.equal(plan.contracts[0].sponsor_id, previous.id);
  assert.equal(plan.contracts[0].kind, "contract");
  assert.equal(plan.contracts[0].name, contract.name);
  assert.ok(plan.contracts[0].bytes.equals(bytes));
  const existing = { ...plan.contracts[0] };
  delete existing.bytes;
  const repeat = planImport(payload, {
    ...state,
    attachments: [...state.attachments, existing],
  });
  assert.equal(repeat.contracts.length, 0);
  assert.equal(repeat.summary.contractsPreserved, 1);
  assert.throws(
    () => planImport(payload, { ...state, sponsors: [] }),
    /existing sponsor/,
  );
  assert.throws(
    () => planImport(payload, { ...state, contractFiles: new Map() }),
    /checksum/,
  );
  assert.throws(
    () =>
      planImport(payload, {
        ...state,
        attachments: [existing, { ...existing, id: randomUUID() }],
      }),
    /duplicated/,
  );
  const sql = transactionSql(plan, payload, "f".repeat(64));
  assert.match(sql, /kind='contract'/);
  assert.match(sql, /Contract import conflict/);
  assert.match(sql, /revision=8/);
  assert.match(sql, /Import verification failed/);
  assert.match(
    sql,
    /delete from public\.maestro_settings where id like 'import-stage:/,
  );
  assert.match(sql, /Import operation conflict/);
});

test("Private contract upload readback verifies the original DOCX bytes and checksum before commit", async () => {
  const { bytes, contract } = contractFixture();
  const good = {
    download: async () => ({ data: new Blob([bytes]), error: null }),
  };
  assert.ok(
    (
      await verifyStoredContract(good, {
        ...contract,
        path: "private-contract",
      })
    ).equals(bytes),
  );
  const corrupted = Buffer.from(bytes);
  corrupted[50] ^= 1;
  await assert.rejects(
    verifyStoredContract(
      { download: async () => ({ data: new Blob([corrupted]) }) },
      contract,
    ),
    /checksum/,
  );
  await assert.rejects(
    verifyStoredContract(
      { download: async () => ({ error: new Error("not printed") }) },
      contract,
    ),
    /could not be verified/,
  );
});

test("Encrypted workflow envelope binds payload, key and project without exposing business fields", () => {
  const payload = fixture();
  payload.sponsors[0].logo = logo();
  const encrypted = encryptEnvelope(payload, key);
  assert.ok(encrypted.length < 60000);
  assert.equal(encrypted.includes(payload.sponsors[0].name), false);
  assert.deepEqual(decryptEnvelope(encrypted, key, projectRef), payload);
  assert.throws(
    () => encryptEnvelope(payload, { ...key, expiresAt: "invalid" }),
    /current public import key/,
  );
  assert.throws(
    () => decryptEnvelope(encrypted, key, "zyxwvutsrqponmlkjihg"),
    /could not be verified/,
  );
  assert.throws(
    () =>
      decryptEnvelope(encrypted, { ...key, keyId: randomUUID() }, projectRef),
    /could not be verified/,
  );
  assert.throws(
    () =>
      decryptEnvelope(
        encrypted,
        { ...key, expiresAt: new Date(Date.now() - 1000).toISOString() },
        projectRef,
      ),
    /expired/,
  );
  const unpacked = JSON.parse(Buffer.from(encrypted, "base64url").toString());
  const bytes = Buffer.from(unpacked.data, "base64url");
  bytes[0] ^= 1;
  unpacked.data = bytes.toString("base64url");
  assert.throws(
    () =>
      decryptEnvelope(
        Buffer.from(JSON.stringify(unpacked)).toString("base64url"),
        key,
        projectRef,
      ),
    /could not be verified/,
  );
  assert.throws(
    () => decryptEnvelope("a".repeat(60001), key, projectRef),
    /could not be verified/,
  );
});

test("Public key helper and unauthenticated route whitelist key material while keeping records protected", async () => {
  const source = { ...key, arbitraryPrivateValue: "must-never-be-returned" };
  const expected = {
    version: 1,
    algorithm: "RSA-OAEP-SHA256+A256GCM",
    keyId: key.keyId,
    publicKey: key.publicKey,
    expiresAt: key.expiresAt,
  };
  assert.deepEqual(await publicImportKey(db({ data: source })), expected);
  assert.equal(await publicImportKey(db(null)), null);
  assert.equal(
    await publicImportKey(
      db({ data: { ...source, publicKey: source.privateKey } }),
    ),
    null,
  );
  assert.equal(
    await publicImportKey(
      db({ data: source }, { message: "private provider detail" }),
    ),
    null,
  );
  assert.equal(
    await publicImportKey(
      db({
        data: {
          ...source,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      }),
    ),
    null,
  );
  const handler = createHandler(db({ data: source }), {
    origins: ["https://example.test"],
  });
  const response = await handler(
    new Request("https://project.test/functions/v1/maestro-api/import-key"),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, expected);
  assert.equal(JSON.stringify(body).includes("PRIVATE KEY"), false);
  assert.equal(
    (
      await handler(
        new Request("https://project.test/functions/v1/maestro-api/sponsors"),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handler(
        new Request(
          "https://project.test/functions/v1/maestro-api/import-key",
          { method: "POST" },
        ),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handler(
        new Request(
          "https://project.test/functions/v1/maestro-api/import-key",
          { headers: { Origin: "https://unapproved.test" } },
        ),
      )
    ).status,
    403,
  );
  const expired = createHandler(
    db({ data: { ...source, expiresAt: new Date(0).toISOString() } }),
  );
  assert.equal(
    (
      await expired(
        new Request("https://project.test/functions/v1/maestro-api/import-key"),
      )
    ).status,
    404,
  );
});

test("Import schema refuses ambiguous identities, unsafe images and undeclared workflow fields", () => {
  const payload = fixture();
  assert.deepEqual(validatePayload(payload, projectRef), payload);
  assert.throws(
    () => validatePayload({ ...payload, unexpected: "private" }, projectRef),
    /schema/,
  );
  assert.throws(
    () =>
      validatePayload(
        {
          ...payload,
          sponsors: [{ ...payload.sponsors[0], approval: "Approved" }],
        },
        projectRef,
      ),
    /schema/,
  );
  assert.throws(
    () =>
      validatePayload(
        {
          ...payload,
          sponsors: [
            payload.sponsors[0],
            { ...payload.sponsors[0], name: " ENCRYPTED fixture COMPANY " },
          ],
        },
        projectRef,
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      validatePayload(
        { ...payload, sponsors: [{ ...payload.sponsors[0], value: 1.001 }] },
        projectRef,
      ),
    /schema/,
  );
  assert.throws(
    () =>
      validatePayload(
        {
          ...payload,
          sponsors: [{ ...payload.sponsors[0], packageBenefitsAr: [] }],
        },
        projectRef,
      ),
    /schema/,
  );
  assert.throws(
    () =>
      validatePayload(
        {
          ...payload,
          sponsors: [
            { ...payload.sponsors[0], logo: { ...logo(), mime: "image/jpeg" } },
          ],
        },
        projectRef,
      ),
    /signature/,
  );
  assert.throws(
    () =>
      imageBytes({
        ...logo(),
        base64: Buffer.from("<svg/>").toString("base64"),
      }),
    /signature/,
  );
  assert.throws(
    () =>
      validatePayload(
        {
          ...payload,
          sponsors: [
            {
              name: payload.sponsors[0].name,
              logoUrl: "https://private.test/logo",
            },
          ],
        },
        projectRef,
      ),
    /schema/,
  );
});

test("New sponsor imports preserve independent defaults and unknown consideration", () => {
  const payload = fixture();
  payload.sponsors.push({
    ...payload.sponsors[0],
    name: "In-kind fixture",
    packageName: "Fixture media partner",
    value: null,
    consideration: "In-kind services; scope is still being defined.",
  });
  payload.sponsors[0].logo = logo();
  const plan = planImport(validatePayload(payload, projectRef), emptyState());
  assert.equal(plan.summary.created, 2);
  assert.equal(plan.summary.packagesCreated, 2);
  assert.equal(plan.summary.logosAdded, 1);
  assert.equal(plan.sponsors[1].data.value, null);
  assert.equal(
    plan.sponsors[1].data.consideration,
    payload.sponsors[1].consideration,
  );
  assert.equal(Object.hasOwn(plan.packages[0].data, "referenceValue"), false);
  for (const s of plan.sponsors) {
    assert.equal(s.data.approval, "Not Approved");
    assert.equal(s.data.poIssued, false);
    assert.deepEqual(s.data.payments, []);
    assert.equal(s.data.contact, "");
    assert.equal(s.data.email, "");
    assert.equal(s.data.benefits[0].completed, false);
    assert.equal(
      s.data.benefits[0].titleAr,
      payload.sponsors[0].benefits[0].titleAr,
    );
  }
  assert.ok(plan.logos[0].bytes.equals(png));
});

test("Existing sponsor import retains contacts, statuses, payments, custom benefits, completions and logo", () => {
  const payload = fixture(),
    packageId = randomUUID(),
    sponsorId = randomUUID(),
    benefitId = randomUUID();
  payload.sponsors[0].logo = logo();
  const old = {
    name: payload.sponsors[0].name.toUpperCase(),
    packageId,
    contact: "Existing fixture contact",
    mobile: "+966501234567",
    email: "existing@example.test",
    approval: "Approved",
    approvalDate: "2026-01-02",
    poIssued: true,
    poNumber: "FIXTURE-PO",
    poDate: "2026-01-03",
    value: 100,
    payments: [
      {
        id: randomUUID(),
        amount: 15,
        date: "2026-01-04",
        note: "Existing fixture payment",
      },
    ],
    benefits: [
      {
        id: benefitId,
        title: payload.sponsors[0].benefits[0].title,
        completed: true,
      },
      { id: randomUUID(), title: "Existing custom benefit", completed: false },
    ],
    notes: "Existing fixture notes",
  };
  const state = {
    packages: [
      {
        id: packageId,
        data: {
          name: payload.sponsors[0].packageName,
          benefits: payload.sponsors[0].packageBenefits,
          referenceValue: 200,
        },
      },
    ],
    sponsors: [
      { id: sponsorId, data: old, package_id: packageId, revision: 6 },
    ],
    attachments: [
      {
        id: randomUUID(),
        sponsor_id: sponsorId,
        kind: "logo",
        path: "existing-logo",
      },
    ],
  };
  const plan = planImport(payload, state);
  const after = plan.sponsors[0].data;
  for (const field of [
    "contact",
    "mobile",
    "email",
    "approval",
    "approvalDate",
    "poIssued",
    "poNumber",
    "poDate",
    "payments",
    "notes",
    "name",
  ])
    assert.deepEqual(after[field], old[field]);
  assert.equal(after.value, payload.sponsors[0].value);
  assert.equal(after.benefits[0].id, benefitId);
  assert.equal(after.benefits[0].completed, true);
  assert.equal(
    after.benefits[0].titleAr,
    payload.sponsors[0].benefits[0].titleAr,
  );
  assert.deepEqual(after.benefits[1], old.benefits[1]);
  assert.equal(plan.packages[0].data.referenceValue, 200);
  assert.equal(plan.summary.logosPreserved, 1);
  assert.equal(plan.logos.length, 0);
  const stateAfter = {
    packages: plan.packages.map(({ id, data }) => ({ id, data })),
    sponsors: [
      { id: sponsorId, data: after, package_id: packageId, revision: 7 },
    ],
    attachments: state.attachments,
  };
  const repeat = planImport(payload, stateAfter);
  assert.equal(repeat.summary.created, 0);
  assert.equal(repeat.summary.updated, 0);
  assert.equal(repeat.sponsors[0].data.benefits.length, 2);
  assert.equal(repeat.summary.logosPreserved, 1);
  assert.throws(
    () =>
      planImport(payload, {
        ...state,
        sponsors: [
          ...state.sponsors,
          { ...state.sponsors[0], id: randomUUID() },
        ],
      }),
    /ambiguous/,
  );
  assert.throws(
    () =>
      mergeBenefits(
        [
          { id: "1", title: "Visibility", completed: true },
          { id: "2", title: "visibility", completed: false },
        ],
        [{ title: "Visibility", titleAr: "الظهور" }],
      ),
    /ambiguous/,
  );
});

test("Transaction locks and verifies workspace identities, uses safe SQL delimiters and replay markers", () => {
  const payload = fixture();
  payload.sponsors[0].name = "Fixture 'quote' $maestro_import$ \\ injection";
  const plan = planImport(payload, emptyState());
  const sql = transactionSql(plan, payload, "a".repeat(64));
  assert.ok(
    sql.startsWith("begin;\nset local standard_conforming_strings=on;"),
  );
  assert.match(sql, /lock table .* in share row exclusive mode;/);
  assert.match(sql, /data->>'hash'/);
  assert.match(sql, /Import verification failed/);
  assert.match(sql, /'Fixture ''quote'' \$maestro_import\$/);
  const delimiter = sql.match(/do (\$import_[a-f0-9]+\$)/)[1];
  assert.equal(sql.split(delimiter).length, 3);
  assert.ok(sql.endsWith("commit;"));
  assert.throws(
    () =>
      planImport(
        { ...fixture(), sponsors: [{ name: "Missing fixture", logo: logo() }] },
        emptyState(),
      ),
    /existing sponsor/,
  );
});

test("Explicit benefit exclusions remove only those entries and empty financial terms preserve existing terms", () => {
  const payload = fixture(),
    packageId = randomUUID();
  payload.sponsors[0].excludedBenefits = [
    "Fixture exhibition booth",
    "Fixture speaking time",
  ];
  const original = {
    name: payload.sponsors[0].name,
    packageId,
    contact: "",
    mobile: "",
    email: "",
    approval: "Not Approved",
    approvalDate: "",
    poIssued: false,
    poNumber: "",
    poDate: "",
    value: 88,
    consideration: "Existing fixture agreement",
    payments: [],
    notes: "",
    benefits: [
      { id: randomUUID(), title: "Fixture exhibition booth", completed: true },
      { id: randomUUID(), title: "Fixture speaking time", completed: false },
      { id: randomUUID(), title: "Custom fixture benefit", completed: true },
    ],
  };
  const plan = planImport(payload, {
    packages: [
      {
        id: packageId,
        data: {
          name: payload.sponsors[0].packageName,
          benefits: payload.sponsors[0].packageBenefits,
          benefitsAr: payload.sponsors[0].packageBenefitsAr,
        },
      },
    ],
    sponsors: [
      { id: randomUUID(), data: original, package_id: packageId, revision: 1 },
    ],
    attachments: [],
  });
  assert.equal(plan.sponsors[0].data.consideration, original.consideration);
  assert.deepEqual(
    plan.sponsors[0].data.benefits.find(
      (b) => b.title === "Custom fixture benefit",
    ),
    original.benefits[2],
  );
  assert.equal(
    plan.sponsors[0].data.benefits.some((b) =>
      payload.sponsors[0].excludedBenefits.includes(b.title),
    ),
    false,
  );
  assert.throws(
    () =>
      validatePayload(
        {
          ...payload,
          sponsors: [
            {
              ...payload.sponsors[0],
              excludedBenefits: [payload.sponsors[0].benefits[0].title],
            },
          ],
        },
        projectRef,
      ),
    /also excludes/,
  );
});

test("Existing sponsor amendments preserve other fields and package definitions while replacing terms", () => {
  const seed = planImport(fixture(), emptyState());
  const previous = structuredClone(seed.sponsors[0]);
  previous.revision = 3;
  previous.data.notes = "Existing private note.";
  previous.data.contact = "Fixture contact";
  previous.data.benefits[0].completed = true;
  const state = {
    packages: seed.packages,
    sponsors: [previous],
    attachments: [],
  };
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId: randomUUID(),
      sponsors: [
        {
          name: previous.data.name,
          update: {
            value: 2000,
            benefits: [
              { title: previous.data.benefits[0].title, titleAr: "ميزة محدثة" },
              { title: "Updated fixture commitment", titleAr: "التزام جديد" },
            ],
            notesAppend: "Additional service is separate from sponsorship.",
          },
        },
      ],
    },
    projectRef,
  );
  const plan = planImport(payload, state);
  assert.equal(plan.packages.length, 0);
  assert.equal(plan.sponsors.length, 1);
  const result = plan.sponsors[0];
  assert.equal(result.id, previous.id);
  assert.equal(result.package_id, previous.package_id);
  assert.equal(result.data.value, 2000);
  assert.equal(result.data.benefits.length, 2);
  assert.equal(result.data.benefits[0].id, previous.data.benefits[0].id);
  assert.equal(result.data.benefits[0].completed, true);
  assert.equal(result.data.benefits[1].completed, false);
  assert.equal(
    result.data.notes,
    previous.data.notes + "\n\n" + payload.sponsors[0].update.notesAppend,
  );
  for (const field of Object.keys(previous.data).filter(
    (f) => !["value", "benefits", "notes"].includes(f),
  ))
    assert.deepEqual(result.data[field], previous.data[field]);
  const repeat = planImport(payload, {
    ...state,
    sponsors: [{ ...result, revision: 4 }],
  });
  assert.equal(repeat.summary.updated, 0);
  assert.deepEqual(repeat.sponsors[0].data, result.data);
  assert.deepEqual(
    decryptEnvelope(encryptEnvelope(payload, key), key, projectRef),
    payload,
  );
  assert.throws(() => planImport(payload, emptyState()), /existing sponsor/);
  const oversized = structuredClone(state);
  oversized.sponsors[0].data.notes = "x".repeat(3000);
  assert.throws(() => planImport(payload, oversized));
});

test("Name-only sponsor creation uses empty independent defaults and preserves existing matches", () => {
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId: randomUUID(),
      sponsors: [{ name: "Name-only fixture", create: true }],
    },
    projectRef,
  );
  assert.deepEqual(
    decryptEnvelope(encryptEnvelope(payload, key), key, projectRef),
    payload,
  );
  const plan = planImport(payload, emptyState());
  assert.equal(plan.summary.created, 1);
  assert.equal(plan.packages.length, 0);
  assert.equal(plan.logos.length, 0);
  const row = plan.sponsors[0];
  assert.equal(row.package_id, null);
  assert.equal(row.data.packageId, "");
  assert.equal(row.data.value, null);
  assert.equal(row.data.approval, "Not Approved");
  assert.equal(row.data.poIssued, false);
  for (const field of [
    "contact",
    "mobile",
    "email",
    "notes",
    "boothSize",
    "boothLocation",
    "poNumber",
    "poDate",
    "approvalDate",
    "consideration",
  ])
    assert.equal(row.data[field], "");
  assert.deepEqual(row.data.payments, []);
  assert.deepEqual(row.data.benefits, []);
  const sql = transactionSql(plan, payload, "fixture-hash");
  assert.match(sql, /insert into public.maestro_sponsors/);
  assert.doesNotMatch(sql, /insert into public.maestro_packages/);
  assert.match(sql, /Import verification failed/);
  const existing = {
    ...row,
    revision: 4,
    data: {
      ...row.data,
      value: 123.45,
      contact: "Existing contact",
      approval: "Approved",
      poIssued: true,
      notes: "Preserve existing record.",
    },
  };
  const repeatPayload = structuredClone(payload);
  repeatPayload.sponsors[0].name = "NAME-ONLY FIXTURE";
  const state = { packages: [], sponsors: [existing], attachments: [] };
  const repeat = planImport(repeatPayload, state);
  assert.equal(repeat.summary.created, 0);
  assert.equal(repeat.summary.updated, 0);
  assert.equal(repeat.sponsors[0].id, existing.id);
  assert.deepEqual(repeat.sponsors[0].data, existing.data);
  assert.throws(
    () =>
      planImport(payload, {
        ...state,
        sponsors: [existing, { ...existing, id: randomUUID() }],
      }),
    /ambiguous/,
  );
  assert.throws(
    () =>
      validatePayload(
        {
          ...payload,
          sponsors: [{ ...payload.sponsors[0], approval: "Approved" }],
        },
        projectRef,
      ),
    /schema/,
  );
});

test("Additive sponsor updates preserve commitments and independent PO/payment state", () => {
  const seed = planImport(fixture(), emptyState());
  const previous = structuredClone(seed.sponsors[0]);
  previous.revision = 2;
  previous.data.benefits[0].completed = true;
  previous.data.poIssued = true;
  previous.data.poNumber = "Existing fixture order";
  previous.data.payments = [
    {
      id: randomUUID(),
      amount: 25,
      date: "2026-10-01",
      note: "Existing receipt",
    },
  ];
  previous.data.notes = "Existing note.";
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId: randomUUID(),
      sponsors: [
        {
          name: previous.data.name,
          update: {
            value: 2000,
            approval: "In Progress",
            notesArAppend: "ملاحظة عربية للاختبار",
            benefitsAppend: [
              { title: "Additional fixture benefit", titleAr: "ميزة إضافية" },
            ],
            notesAppend:
              "Preliminary approval; final internal approvals pending.",
          },
        },
      ],
    },
    projectRef,
  );
  const state = {
    packages: seed.packages,
    sponsors: [previous],
    attachments: [],
  };
  const plan = planImport(payload, state);
  assert.equal(plan.packages.length, 0);
  const result = plan.sponsors[0];
  assert.equal(result.data.approval, "In Progress");
  assert.equal(result.data.notesAr, "ملاحظة عربية للاختبار");
  assert.equal(result.data.value, 2000);
  assert.equal(result.data.benefits.length, 2);
  assert.deepEqual(result.data.benefits[0], previous.data.benefits[0]);
  assert.equal(result.data.benefits[1].completed, false);
  for (const field of Object.keys(previous.data).filter(
    (f) => !["approval", "value", "benefits", "notes", "notesAr"].includes(f),
  ))
    assert.deepEqual(result.data[field], previous.data[field]);
  assert.deepEqual(
    decryptEnvelope(encryptEnvelope(payload, key), key, projectRef),
    payload,
  );
  const repeat = planImport(payload, {
    ...state,
    sponsors: [{ ...result, revision: 3 }],
  });
  assert.equal(repeat.summary.updated, 0);
  assert.deepEqual(repeat.sponsors[0].data, result.data);
  for (const update of [
    { ...payload.sponsors[0].update, benefits: [] },
    { value: 2000, notesAppend: "Missing benefit mode" },
    { ...payload.sponsors[0].update, approval: "Preliminary" },
  ])
    assert.throws(
      () =>
        validatePayload(
          { ...payload, sponsors: [{ name: previous.data.name, update }] },
          projectRef,
        ),
      /schema/,
    );
});

test("Contact amendments preserve existing channels and statuses while recording a requested benefit", () => {
  const seed = planImport(fixture(), emptyState());
  const previous = structuredClone(seed.sponsors[0]);
  previous.revision = 2;
  previous.data.contact = "Previous fixture contact";
  previous.data.mobile = "+966501234567";
  previous.data.email = "previous-contact@example.test";
  previous.data.approval = "Approved";
  previous.data.poIssued = true;
  previous.data.benefits[0].completed = true;
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId: randomUUID(),
      sponsors: [
        {
          name: previous.data.name,
          update: {
            value: 1500,
            contact: "New fixture contact",
            benefitsAppend: [
              {
                title:
                  "Requested screen visibility; organizer confirmation pending.",
                titleAr: "طلب ظهور على الشاشات؛ بانتظار تأكيد المنظمين.",
              },
            ],
            notesAppend:
              "Updated designated contact; no replacement contact channels supplied.",
          },
        },
      ],
    },
    projectRef,
  );
  const result = planImport(payload, {
    packages: seed.packages,
    sponsors: [previous],
    attachments: [],
  });
  assert.equal(result.packages.length, 0);
  const data = result.sponsors[0].data;
  assert.equal(data.value, 1500);
  assert.equal(data.contact, "New fixture contact");
  assert.deepEqual(data.benefits[0], previous.data.benefits[0]);
  assert.equal(data.benefits[1].completed, false);
  assert.match(data.benefits[1].title, /Requested.*pending/);
  for (const field of Object.keys(previous.data).filter(
    (f) => !["value", "contact", "benefits", "notes"].includes(f),
  ))
    assert.deepEqual(data[field], previous.data[field]);
  assert.deepEqual(
    decryptEnvelope(encryptEnvelope(payload, key), key, projectRef),
    payload,
  );
  assert.throws(
    () =>
      validatePayload(
        {
          ...payload,
          sponsors: [
            {
              ...payload.sponsors[0],
              update: {
                ...payload.sponsors[0].update,
                contact: "x".repeat(101),
              },
            },
          ],
        },
        projectRef,
      ),
    /schema/,
  );
});
