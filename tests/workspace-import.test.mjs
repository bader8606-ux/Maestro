import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  createImportKey,
  decryptEnvelope,
  encryptEnvelope,
  imageBytes,
  mergeBenefits,
  planImport,
  transactionSql,
  validatePayload,
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
