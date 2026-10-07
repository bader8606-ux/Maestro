// Optional actual Postgres check. Only an isolated disposable container is accepted:
// MAESTRO_BOOTH_TEST_CONTAINER=maestro-booth-fixture node --test tests/booth-migration.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const container = process.env.MAESTRO_BOOTH_TEST_CONTAINER;
if (!container || !/^maestro-booth-fixture(?:-[a-z0-9]+)?$/.test(container))
  throw new Error(
    "Provide an explicit disposable booth fixture container; remote database URLs are unsupported.",
  );
const dockerEnv = { ...process.env };
for (const selector of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete dockerEnv[selector];
const docker = (args, options = {}) =>
  spawnSync("docker", ["--host=unix:///var/run/docker.sock", ...args], {
    ...options,
    env: dockerEnv,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
const inspected = docker([
  "inspect",
  container,
  "--format",
  "{{json .HostConfig.NetworkMode}} {{json .HostConfig.Tmpfs}} {{json .Config.User}}",
]);
assert.equal(inspected.status, 0);
assert.match(
  inspected.stdout,
  /^"none" /,
  "The database fixture has no network access.",
);
assert.match(
  inspected.stdout,
  /"\/tmp":/,
  "Fixture data is in a disposable tmpfs.",
);
assert.match(
  inspected.stdout.trim(),
  /"postgres"$/,
  "The database runs as an unprivileged user.",
);
const query = (sql) => {
  const result = docker(
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
    { input: sql },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
};
const json = (sql) => JSON.parse(query(sql));
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const jsonb = (value) => quote(JSON.stringify(value)) + "::jsonb";
query(`create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
  create table auth.sessions(id uuid primary key,user_id uuid);
  create schema storage;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
query(
  await readFile(
    new URL(
      "../supabase/migrations/20261005000100_maestro.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
const sponsorId = randomUUID();
const sponsorData = {
  name: "Legacy booth migration fixture",
  packageId: "",
  contact: "Fixture contact",
  mobile: "",
  email: "fixture@example.test",
  approval: "In Progress",
  approvalDate: "2026-10-01",
  poIssued: true,
  poNumber: "FIXTURE-PO-1",
  poDate: "2026-10-02",
  value: 1000.1,
  payments: [
    {
      id: randomUUID(),
      amount: 100.1,
      date: "2026-10-03",
      note: "Fixture receipt",
    },
  ],
  benefits: [
    {
      id: randomUUID(),
      title: "Fixture benefit",
      titleAr: "ميزة تجريبية",
      completed: true,
    },
  ],
  notes: "Fixture notes",
};
query(
  `insert into public.maestro_sponsors(id,data,revision) values(${quote(sponsorId)},${jsonb(sponsorData)},7);`,
);
for (const kind of ["approval", "purchase-order", "logo"])
  query(
    `insert into public.maestro_attachments(sponsor_id,kind,name,mime,size,path) values(${quote(sponsorId)},${quote(kind)},'fixture.png','image/png',1,${quote(randomUUID())});`,
  );
const security = () =>
  json(`select json_build_object(
  'tables',(select json_agg(row) from (select relname,relrowsecurity,relacl::text from pg_class where relnamespace='public'::regnamespace and relname like 'maestro_%' and relkind='r' order by relname)row),
  'permissions',(select json_agg(row) from (select r.rolname,has_table_privilege(r.rolname,'public.maestro_attachments','SELECT') as can_read,has_table_privilege(r.rolname,'public.maestro_attachments','INSERT') as can_insert,has_table_privilege(r.rolname,'public.maestro_attachments','UPDATE') as can_update,has_table_privilege(r.rolname,'public.maestro_attachments','DELETE') as can_delete from pg_roles r where r.rolname in ('anon','authenticated','service_role') order by r.rolname)row),
  'policies',(select coalesce(json_agg(row),'[]') from (select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname in ('public','storage') order by schemaname,tablename,policyname)row),
  'bucket',(select row_to_json(b) from storage.buckets b where id='maestro-files'))`);
const state = () =>
  json(`select json_build_object(
  'sponsors',(select json_agg(s) from(select * from public.maestro_sponsors order by id)s),
  'attachments',(select json_agg(a) from(select * from public.maestro_attachments order by id)a),
  'settings',(select json_agg(b) from(select * from public.maestro_settings order by id)b))`);
const before = state(),
  beforeSecurity = security();
const migration = await readFile(
  new URL(
    "../supabase/migrations/20261007000100_booth_details.sql",
    import.meta.url,
  ),
  "utf8",
);

test("Booth migration preserves existing sponsor JSON, revisions, workflow fields and all old attachment rows", () => {
  query("begin;\n" + migration + "\ncommit;");
  assert.deepEqual(state(), before);
  const record = state().sponsors[0];
  assert.deepEqual(record.data, sponsorData);
  assert.equal(record.revision, 7);
  assert.equal(Object.hasOwn(record.data, "boothSize"), false);
  assert.equal(Object.hasOwn(record.data, "boothLocation"), false);
  assert.deepEqual(
    state()
      .attachments.map((a) => a.kind)
      .sort(),
    ["approval", "logo", "purchase-order"],
  );
});

test("New private booth attachment kinds accept images and PDFs while invalid kinds still fail", () => {
  for (const [kind, mime] of [
    ["booth-location", "image/png"],
    ["booth-location", "application/pdf"],
    ["booth-design", "application/pdf"],
    ["booth-design", "image/jpeg"],
  ])
    query(
      `insert into public.maestro_attachments(sponsor_id,kind,name,mime,size,path) values(${quote(sponsorId)},${quote(kind)},'booth-fixture',${quote(mime)},1,${quote(randomUUID())});`,
    );
  assert.equal(state().attachments.length, 7);
  assert.throws(
    () =>
      query(
        `insert into public.maestro_attachments(sponsor_id,kind,name,mime,size,path) values(${quote(sponsorId)},'booth-area','invalid','image/png',1,${quote(randomUUID())});`,
      ),
    /maestro_attachments_kind_check/,
  );
  assert.equal(state().attachments.length, 7);
  assert.deepEqual(state().sponsors, before.sponsors);
});

test("Booth migration leaves row security, role grants and private storage configuration unchanged", () => {
  const after = security();
  assert.deepEqual(after, beforeSecurity);
  for (const role of after.permissions) {
    const allowed = role.rolname === "service_role";
    for (const field of ["can_read", "can_insert", "can_update", "can_delete"])
      assert.equal(role[field], allowed, role.rolname + " " + field);
  }
  assert.equal(
    after.tables.every((table) => table.relrowsecurity),
    true,
  );
  assert.equal(after.bucket.public, false);
  assert.equal(after.bucket.file_size_limit, 10485760);
  assert.deepEqual(after.bucket.allowed_mime_types, [
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
  ]);
});
