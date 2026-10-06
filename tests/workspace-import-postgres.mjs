// Explicit disposable integration check; never points at a production database.
// Start an isolated cached Postgres container, then set this container name only:
// MAESTRO_IMPORT_TEST_CONTAINER=maestro-import-fixture node --test tests/workspace-import-postgres.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
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
