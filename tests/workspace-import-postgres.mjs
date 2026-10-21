// Explicit disposable integration check; never points at a production database.
// Start an isolated cached Postgres container, then set this container name only:
// MAESTRO_IMPORT_TEST_CONTAINER=maestro-import-fixture node --test tests/workspace-import-postgres.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { DOCX_MIME } from "../supabase/functions/maestro-api/document-files.mjs";
import {
  assembleQuotationFiles,
  assembleContractFiles,
  buildContractStages,
  buildQuotationStages,
  createImportKey,
  stageSql,
  planImport,
  transactionSql,
  validatePayload,
} from "../scripts/workspace-import.mjs";

const container = process.env.MAESTRO_IMPORT_TEST_CONTAINER;
if (!container || !/^maestro-import-fixture(?:-[a-z0-9]+)?$/.test(container))
  throw new Error(
    "Provide the explicit disposable import fixture container; remote database URLs are unsupported.",
  );
const inspect = spawnSync(
  "docker",
  ["inspect", container, "--format", "{{.HostConfig.NetworkMode}}"],
  { encoding: "utf8" },
);
assert.equal(inspect.status, 0);
assert.equal(
  inspect.stdout.trim(),
  "none",
  "Integration fixture has no network access.",
);
const query = (sql) => {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-h",
      "/tmp",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-X",
      "-q",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: sql, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
};
const json = (sql) => JSON.parse(query(sql));
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const value = (data) => quote(JSON.stringify(data)) + "::jsonb";
const state = () => ({
  packages: json(
    "select coalesce(json_agg(p),'[]') from(select id,data from public.maestro_packages)p",
  ),
  sponsors: json(
    "select coalesce(json_agg(p),'[]') from(select id,data,package_id,revision from public.maestro_sponsors)p",
  ),
  attachments: json(
    "select coalesce(json_agg(p),'[]') from(select id,sponsor_id,kind,path from public.maestro_attachments)p",
  ),
});
const projectRef = "abcdefghijklmnopqrst";
const company = (name, pkg) => ({
  name,
  packageName: pkg,
  packageBenefits: ["Fixture visibility"],
  packageBenefitsAr: ["الظهور التجريبي"],
  value: 150.99,
  consideration: "",
  benefits: [{ title: "Fixture visibility", titleAr: "الظهور التجريبي" }],
});

await query(`create role anon; create role authenticated; create role service_role;
create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid);
create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
await query(
  await readFile(
    new URL(
      "../supabase/migrations/20261005000100_maestro.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("Actual protected database transaction imports bilingual records and replays without duplicates", () => {
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId: randomUUID(),
      sponsors: [
        company(
          "Fixture 'quoted' $maestro_import$ company",
          "Fixture alpha package",
        ),
        {
          ...company("Fixture in-kind company", "Fixture media package"),
          value: null,
          consideration: "In-kind fixture services",
          excludedBenefits: ["Fixture stage time"],
        },
      ],
    },
    projectRef,
  );
  const plan = planImport(payload, state());
  const aggregate = json(transactionSql(plan, payload, "a".repeat(64)));
  assert.equal(aggregate.created, 2);
  assert.equal(aggregate.verified, true);
  const after = state();
  assert.equal(after.sponsors.length, 2);
  for (const row of after.sponsors) {
    assert.equal(row.data.approval, "Not Approved");
    assert.equal(row.data.poIssued, false);
    assert.deepEqual(row.data.payments, []);
    assert.equal(row.data.benefits[0].titleAr, "الظهور التجريبي");
  }
  assert.equal(
    after.sponsors.find((s) => s.data.name === "Fixture in-kind company").data
      .value,
    null,
  );
  assert.deepEqual(
    json(transactionSql(plan, payload, "a".repeat(64))),
    aggregate,
  );
  assert.deepEqual(state(), after);
  assert.throws(
    () => query(transactionSql(plan, payload, "b".repeat(64))),
    /Import operation conflict/,
  );
  assert.deepEqual(state(), after);
});

test("Actual import retains existing workflow fields and custom completions while removing only explicit exclusions", () => {
  const packageId = randomUUID(),
    sponsorId = randomUUID(),
    benefitId = randomUUID();
  const pkg = {
    name: "Fixture preservation package",
    benefits: ["Fixture visibility"],
    referenceValue: 1000,
  };
  const data = {
    name: "FIXTURE PRESERVATION COMPANY",
    packageId,
    contact: "Existing fixture contact",
    mobile: "+966501234567",
    email: "fixture@example.test",
    approval: "In Progress",
    approvalDate: "2026-10-01",
    poIssued: true,
    poNumber: "FIXTURE-PO-2",
    poDate: "2026-10-02",
    value: 99.99,
    consideration: "Existing negotiated fixture terms",
    payments: [
      {
        id: randomUUID(),
        amount: 20.01,
        date: "2026-10-03",
        note: "Fixture receipt",
      },
    ],
    benefits: [
      { id: benefitId, title: "Fixture visibility", completed: true },
      { id: randomUUID(), title: "Fixture stage time", completed: true },
      { id: randomUUID(), title: "Fixture custom benefit", completed: false },
    ],
    notes: "Existing fixture notes",
  };
  query(
    `insert into maestro_packages(id,data) values(${quote(packageId)},${value(pkg)});insert into maestro_sponsors(id,data,package_id,revision) values(${quote(sponsorId)},${value(data)},${quote(packageId)},5)`,
  );
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId: randomUUID(),
      sponsors: [
        {
          ...company("fixture preservation company", pkg.name),
          value: null,
          excludedBenefits: ["Fixture stage time"],
        },
      ],
    },
    projectRef,
  );
  const plan = planImport(payload, state());
  assert.equal(json(transactionSql(plan, payload, "c".repeat(64))).updated, 1);
  const row = state().sponsors.find((s) => s.id === sponsorId);
  for (const field of [
    "name",
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
    "consideration",
  ])
    assert.deepEqual(row.data[field], data[field]);
  assert.equal(row.data.value, null);
  assert.equal(row.data.benefits[0].id, benefitId);
  assert.equal(row.data.benefits[0].completed, true);
  assert.equal(row.data.benefits[0].titleAr, "الظهور التجريبي");
  assert.equal(
    row.data.benefits.some((b) => b.title === "Fixture stage time"),
    false,
  );
  assert.deepEqual(
    row.data.benefits.find((b) => b.title === "Fixture custom benefit"),
    data.benefits[2],
  );
  assert.equal(
    state().packages.find((p) => p.id === packageId).data.referenceValue,
    1000,
  );
  assert.equal(row.revision, 6);
});

test("Actual optimistic conflicts roll back package changes and marker insertion", () => {
  const before = state(),
    existing = before.sponsors.find(
      (s) => s.data.name === "FIXTURE PRESERVATION COMPANY",
    );
  const payload = {
    version: 1,
    projectRef,
    operationId: randomUUID(),
    sponsors: [
      {
        ...company(existing.data.name, "Fixture conflict package"),
        value: 123,
      },
    ],
  };
  const plan = planImport(payload, before);
  query(
    `update maestro_sponsors set revision=revision+1,data=jsonb_set(data,'{contact}','"Concurrent fixture contact"'::jsonb) where id=${quote(existing.id)}`,
  );
  assert.throws(
    () => query(transactionSql(plan, payload, "d".repeat(64))),
    /Import conflict/,
  );
  const after = state();
  assert.equal(
    after.packages.some((p) => p.data.name === "Fixture conflict package"),
    false,
  );
  assert.equal(
    after.sponsors.find((s) => s.id === existing.id).data.contact,
    "Concurrent fixture contact",
  );
  assert.equal(
    query(
      `select count(*) from maestro_settings where id=${quote("import:" + payload.operationId)}`,
    ),
    "0",
  );
});

test("Actual logo metadata attaches to the correct owner and protected import settings remain unreadable", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
    "base64",
  );
  const payload = {
    version: 1,
    projectRef,
    operationId: randomUUID(),
    sponsors: [
      {
        ...company("Fixture logo company", "Fixture logo package"),
        logo: {
          name: "fixture.png",
          mime: "image/png",
          base64: png.toString("base64"),
        },
      },
    ],
  };
  const plan = planImport(payload, state());
  assert.equal(
    json(transactionSql(plan, payload, "e".repeat(64))).logosAdded,
    1,
  );
  const after = state(),
    row = after.sponsors.find((s) => s.data.name === payload.sponsors[0].name);
  const attachment = after.attachments.find((a) => a.sponsor_id === row.id);
  assert.equal(attachment.id, plan.logos[0].id);
  assert.equal(attachment.kind, "logo");
  assert.equal(attachment.path, plan.logos[0].path);
  const repeat = planImport(payload, after);
  assert.equal(repeat.logos.length, 0);
  assert.equal(repeat.summary.logosPreserved, 1);
  assert.throws(
    () =>
      query(
        "set role authenticated; select data from public.maestro_settings where id='import-key'",
      ),
    /permission denied/,
  );
});

test("Actual quotation staging verifies ownership, imports without changing sponsor data and clears staged chunks", async () => {
  for (const name of [
    "20261007000100_booth_details.sql",
    "20261018000100_quotation_attachments.sql",
  ])
    query(
      await readFile(
        new URL("../supabase/migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
  const before = state();
  const sponsor = before.sponsors.find(
    (row) => row.data.name === "FIXTURE PRESERVATION COMPANY",
  );
  const key = createImportKey();
  query(
    `insert into maestro_settings(id,data) values('import-key',${value(key)}) on conflict(id) do update set data=excluded.data`,
  );
  const operationId = randomUUID();
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    randomBytes(42000),
    Buffer.from("\n%%EOF"),
  ]);
  const file = buildQuotationStages({
    projectRef,
    operationId,
    sponsorName: sponsor.data.name,
    fileName: "Fixture quotation.pdf",
    bytes,
  });
  for (const part of file.stages) {
    assert.equal(query(stageSql(part, key)), "t");
    assert.equal(query(stageSql(part, key)), "t");
  }
  const stagedRows = json(
    `select coalesce(json_agg(p),'[]') from(select data from maestro_settings where id like ${quote("import-stage:" + operationId + ":%")})p`,
  );
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId,
      sponsors: [{ name: sponsor.data.name, quotations: [file.quotation] }],
    },
    projectRef,
  );
  const quotationFiles = assembleQuotationFiles(payload, stagedRows, key);
  assert.deepEqual(quotationFiles.get(file.quotation.fileId), bytes);
  const plan = planImport(payload, { ...before, quotationFiles });
  assert.deepEqual(plan.sponsors[0].data, sponsor.data);
  assert.equal(plan.quotations.length, 1);
  const sql = transactionSql(plan, payload, "f".repeat(64));
  const summary = json(sql);
  assert.equal(summary.verified, true);
  assert.equal(summary.quotationsAdded, 1);
  assert.deepEqual(json(sql), summary);
  const after = state();
  const saved = after.sponsors.find((row) => row.id === sponsor.id);
  assert.deepEqual(saved.data, sponsor.data);
  assert.equal(saved.revision, sponsor.revision + 1);
  const quoteFiles = after.attachments.filter(
    (a) => a.sponsor_id === sponsor.id && a.kind === "quotation",
  );
  assert.equal(quoteFiles.length, 1);
  assert.equal(quoteFiles[0].id, plan.quotations[0].id);
  assert.equal(quoteFiles[0].path, plan.quotations[0].path);
  assert.equal(
    query(
      `select count(*) from maestro_settings where id like ${quote("import-stage:" + operationId + ":%")}`,
    ),
    "0",
  );
  assert.throws(
    () =>
      query("set role authenticated; select * from public.maestro_attachments"),
    /permission denied/,
  );
});

test("Actual DOCX contract staging preserves records, quotations and package associations with private metadata", async () => {
  for (const name of [
    "20261019000100_contract_attachments.sql",
    "20261019000200_contract_docx.sql",
  ])
    query(
      await readFile(
        new URL("../supabase/migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
  assert.equal(
    query(
      `select ${quote(DOCX_MIME)}=any(allowed_mime_types) from storage.buckets where id='maestro-files'`,
    ),
    "t",
  );
  const before = state(),
    sponsor = before.sponsors.find(
      (row) => row.data.name === "FIXTURE PRESERVATION COMPANY",
    );
  const key = createImportKey();
  query(
    `insert into maestro_settings(id,data) values('import-key',${value(key)}) on conflict(id) do update set data=excluded.data`,
  );
  const operationId = randomUUID();
  const bytes = Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      "word/document.xml": strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fixture contract</w:t></w:r></w:p></w:body></w:document>',
      ),
    }),
  );
  const file = buildContractStages({
    projectRef,
    operationId,
    sponsorName: sponsor.data.name,
    fileName: "عقد تجريبي.docx",
    bytes,
  });
  for (const part of file.stages) assert.equal(query(stageSql(part, key)), "t");
  const staged = json(
    `select coalesce(json_agg(p),'[]') from(select data from maestro_settings where id like ${quote("import-stage:" + operationId + ":%")})p`,
  );
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId,
      sponsors: [{ name: sponsor.data.name, contracts: [file.contract] }],
    },
    projectRef,
  );
  const contractFiles = assembleContractFiles(payload, staged, key);
  assert.deepEqual(contractFiles.get(file.contract.fileId), bytes);
  const plan = planImport(payload, { ...before, contractFiles });
  assert.deepEqual(plan.sponsors[0].data, sponsor.data);
  assert.equal(plan.contracts.length, 1);
  const sql = transactionSql(plan, payload, "a2".repeat(32));
  const summary = json(sql);
  assert.equal(summary.verified, true);
  assert.equal(summary.contractsAdded, 1);
  assert.deepEqual(json(sql), summary);
  const after = state(),
    saved = after.sponsors.find((row) => row.id === sponsor.id);
  assert.deepEqual(saved.data, sponsor.data);
  assert.equal(saved.package_id, sponsor.package_id);
  assert.equal(saved.revision, sponsor.revision + 1);
  assert.deepEqual(
    after.attachments.filter((a) => a.kind === "quotation"),
    before.attachments.filter((a) => a.kind === "quotation"),
  );
  assert.equal(
    after.attachments.filter(
      (a) => a.sponsor_id === sponsor.id && a.kind === "contract",
    ).length,
    1,
  );
  const metadata = json(
    `select row_to_json(a) from maestro_attachments a where id=${quote(plan.contracts[0].id)}`,
  );
  assert.equal(metadata.kind, "contract");
  assert.equal(metadata.mime, DOCX_MIME);
  assert.equal(metadata.name, "عقد تجريبي.docx");
  assert.equal(metadata.sponsor_id, sponsor.id);
  assert.equal(
    query(
      `select count(*) from maestro_settings where id like ${quote("import-stage:" + operationId + ":%")}`,
    ),
    "0",
  );
  assert.throws(
    () => query("set role anon; select * from public.maestro_attachments"),
    /permission denied/,
  );
});

test("Sponsor renaming commits only the name, preserves ownership and replays safely", () => {
  const input = {
    version: 1,
    projectRef,
    operationId: randomUUID(),
    sponsors: [company("Fixture rename source", "Fixture rename package")],
  };
  const seed = validatePayload(input, projectRef);
  json(transactionSql(planImport(seed, state()), seed, "1".repeat(64)));
  const source = state().sponsors.find(
    (s) => s.data.name === "Fixture rename source",
  );
  const full = {
    ...source.data,
    contact: "Fixture contact",
    mobile: "+966500000001",
    email: "fixture@example.test",
    approval: "Approved",
    approvalDate: "2026-10-20",
    poIssued: true,
    poNumber: "Fixture PO",
    poDate: "2026-10-21",
    payments: [
      {
        id: randomUUID(),
        amount: 10.25,
        date: "2026-10-21",
        note: "Fixture receipt",
      },
    ],
    notes: "Fixture private note",
    notesAr: "ملاحظة تجريبية",
    boothSize: "3 × 3 m",
    boothLocation: "Fixture location",
    benefits: source.data.benefits.map((b) => ({ ...b, completed: true })),
  };
  query(`update maestro_sponsors set data=${value(full)} where id=${quote(source.id)};
insert into maestro_attachments(id,sponsor_id,kind,name,mime,size,path) values(${quote(randomUUID())},${quote(source.id)},'logo','fixture.png','image/png',1,${quote("fixture/" + randomUUID())});`);
  const before = state();
  const old = before.sponsors.find((s) => s.id === source.id);
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId: randomUUID(),
      sponsors: [
        { name: old.data.name, renameTo: "Fixture renamed (جهة تجريبية)" },
      ],
    },
    projectRef,
  );
  const plan = planImport(payload, before);
  const sql = transactionSql(plan, payload, "2".repeat(64));
  const summary = json(sql);
  assert.equal(summary.updated, 1);
  const after = state();
  const saved = after.sponsors.find((s) => s.id === source.id);
  assert.deepEqual(saved.data, {
    ...old.data,
    name: payload.sponsors[0].renameTo,
  });
  assert.equal(saved.package_id, old.package_id);
  assert.equal(saved.revision, old.revision + 1);
  assert.deepEqual(after.attachments, before.attachments);
  assert.deepEqual(after.packages, before.packages);
  assert.deepEqual(json(sql), summary);
  assert.deepEqual(state(), after);
});

test("A target inserted after rename planning causes a complete rollback", () => {
  const payloadSeed = validatePayload(
    {
      version: 1,
      projectRef,
      operationId: randomUUID(),
      sponsors: [company("Fixture late rename source", "Fixture late package")],
    },
    projectRef,
  );
  json(
    transactionSql(
      planImport(payloadSeed, state()),
      payloadSeed,
      "3".repeat(64),
    ),
  );
  const before = state();
  const source = before.sponsors.find(
    (s) => s.data.name === "Fixture late rename source",
  );
  const payload = validatePayload(
    {
      version: 1,
      projectRef,
      operationId: randomUUID(),
      sponsors: [{ name: source.data.name, renameTo: "Fixture target" }],
    },
    projectRef,
  );
  const plan = planImport(payload, before);
  query(
    `insert into maestro_sponsors(id,data,package_id) values(${quote(randomUUID())},${value({ ...source.data, name: "Ｆｉｘｔｕｒｅ ｔａｒｇｅｔ" })},${quote(source.package_id)});`,
  );
  const raced = state();
  assert.throws(
    () => query(transactionSql(plan, payload, "4".repeat(64))),
    /Import conflict/,
  );
  assert.deepEqual(state(), raced);
  assert.equal(
    query(
      `select count(*) from maestro_settings where id=${quote("import:" + payload.operationId)}`,
    ),
    "0",
  );
});
