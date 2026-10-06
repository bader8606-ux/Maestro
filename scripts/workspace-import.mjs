// Authorized, ephemeral import runner. Production credentials are bound by
// GitHub Actions; plaintext business records never enter source or workflow logs.
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import {
  sponsorSchema,
  packageSchema,
} from "../supabase/functions/maestro-api/validation.mjs";

const algorithm = "RSA-OAEP-SHA256+A256GCM";
const maxEnvelope = 60000;
const maxPlaintext = 2 * 1024 * 1024;
const keyLifetime = 2 * 60 * 60 * 1000;
const text = (max) => z.string().trim().min(1).max(max);
const money = z
  .number()
  .finite()
  .min(0)
  .max(9999999999)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001);
const image = z
  .object({
    name: text(240).refine((name) => !/[\r\n\0\\/]/.test(name)),
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z
      .string()
      .min(1)
      .max(14000000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
const benefit = z
  .object({ title: text(300), titleAr: z.string().trim().max(300) })
  .strict();
const company = z
  .object({
    name: text(200),
    packageName: text(100),
    packageBenefits: z.array(text(300)).max(300),
    packageBenefitsAr: z.array(z.string().trim().max(300)).max(300),
    referenceValue: money.optional(),
    value: money.nullable(),
    consideration: z.string().trim().max(1000),
    benefits: z.array(benefit).max(300),
    excludedBenefits: z.array(text(300)).max(300).optional(),
    logo: image.optional(),
  })
  .strict()
  .refine((s) => s.packageBenefits.length === s.packageBenefitsAr.length);
const logoOnly = z.object({ name: text(200), logo: image }).strict();
const payloadSchema = z
  .object({
    version: z.literal(1),
    projectRef: z.string().regex(/^[a-z]{20}$/),
    operationId: z.string().uuid(),
    sponsors: z
      .array(z.union([company, logoOnly]))
      .min(1)
      .max(20),
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal(algorithm),
    projectRef: z.string().regex(/^[a-z]{20}$/),
    keyId: z.string().uuid(),
    key: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(1024),
    iv: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(32),
    tag: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(32),
    data: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(maxEnvelope),
  })
  .strict();
const normalized = (value) =>
  value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sqlString = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const sqlJson = (value) => sqlString(JSON.stringify(value)) + "::jsonb";
const sqlUuid = (value) => sqlString(z.string().uuid().parse(value)) + "::uuid";

export function imageBytes(logo) {
  const bytes = Buffer.from(logo.base64, "base64");
  if (
    !bytes.length ||
    bytes.length > 10 * 1024 * 1024 ||
    bytes.toString("base64") !== logo.base64
  )
    throw new Error(
      "The encrypted logo is invalid or exceeds the image limit.",
    );
  let actual;
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    actual = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    actual = "image/jpeg";
  else if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    actual = "image/webp";
  if (actual !== logo.mime)
    throw new Error("The encrypted logo has an invalid image signature.");
  return bytes;
}

export function validatePayload(input, projectRef) {
  const result = payloadSchema.safeParse(input);
  if (!result.success || result.data.projectRef !== projectRef)
    throw new Error(
      "The encrypted import schema or project reference is invalid.",
    );
  const data = result.data;
  const names = data.sponsors.map((s) => normalized(s.name));
  if (new Set(names).size !== names.length)
    throw new Error(
      "The encrypted import contains duplicate sponsor identities.",
    );
  for (const s of data.sponsors) {
    if (s.logo) imageBytes(s.logo);
    if (
      s.benefits &&
      new Set(s.benefits.map((b) => normalized(b.title))).size !==
        s.benefits.length
    )
      throw new Error("The encrypted import contains duplicate benefits.");
    if (
      s.excludedBenefits?.some((excluded) =>
        s.benefits.some((b) => normalized(b.title) === normalized(excluded)),
      )
    )
      throw new Error(
        "The encrypted import includes a benefit that it also excludes.",
      );
  }
  return data;
}

export function createImportKey(now = Date.now()) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    keyId: randomUUID(),
    publicKey,
    privateKey,
    expiresAt: new Date(now + keyLifetime).toISOString(),
  };
}

const aad = (envelope) =>
  Buffer.from(
    `${envelope.version}:${envelope.algorithm}:${envelope.projectRef}:${envelope.keyId}`,
  );
export function encryptEnvelope(input, key, now = Date.now()) {
  const payload = validatePayload(input, input.projectRef);
  const expiry = Date.parse(key?.expiresAt);
  if (
    !key?.publicKey ||
    !z.string().uuid().safeParse(key.keyId).success ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > now + keyLifetime + 60000
  )
    throw new Error("A current public import key is required.");
  const plaintext = Buffer.from(JSON.stringify(payload));
  if (plaintext.length > maxPlaintext)
    throw new Error("The encrypted import exceeds the payload limit.");
  const secret = randomBytes(32),
    iv = randomBytes(12);
  const envelope = {
    version: 1,
    algorithm,
    projectRef: payload.projectRef,
    keyId: key.keyId,
    key: publicEncrypt(
      {
        key: key.publicKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      secret,
    ).toString("base64url"),
    iv: iv.toString("base64url"),
    tag: "",
    data: "",
  };
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(aad(envelope));
  envelope.data = Buffer.concat([
    cipher.update(gzipSync(plaintext)),
    cipher.final(),
  ]).toString("base64url");
  envelope.tag = cipher.getAuthTag().toString("base64url");
  secret.fill(0);
  const encoded = Buffer.from(JSON.stringify(envelope)).toString("base64url");
  if (encoded.length > maxEnvelope)
    throw new Error(
      "The encrypted envelope exceeds the workflow input limit; split the import.",
    );
  return encoded;
}

export function decryptEnvelope(encoded, key, projectRef, now = Date.now()) {
  try {
    if (
      typeof encoded !== "string" ||
      encoded.length > maxEnvelope ||
      !/^[A-Za-z0-9_-]+$/.test(encoded)
    )
      throw new Error();
    const e = envelopeSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    const expiry = Date.parse(key?.expiresAt);
    if (
      e.projectRef !== projectRef ||
      e.keyId !== key?.keyId ||
      !Number.isFinite(expiry) ||
      expiry <= now ||
      expiry > now + keyLifetime + 60000
    )
      throw new Error();
    const secret = privateDecrypt(
      {
        key: key.privateKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(e.key, "base64url"),
    );
    if (secret.length !== 32) throw new Error();
    const iv = Buffer.from(e.iv, "base64url"),
      tag = Buffer.from(e.tag, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", secret, iv);
    decipher.setAAD(aad(e));
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([
      decipher.update(Buffer.from(e.data, "base64url")),
      decipher.final(),
    ]);
    secret.fill(0);
    return validatePayload(
      JSON.parse(
        gunzipSync(compressed, { maxOutputLength: maxPlaintext }).toString(
          "utf8",
        ),
      ),
      projectRef,
    );
  } catch {
    throw new Error(
      "The encrypted import could not be verified, is expired, or targets another project.",
    );
  }
}

// Translation enriches an existing benefit without replacing its ID, completion
// flag, or custom benefits. Exact normalized names are deliberately required.
export function mergeBenefits(existing, incoming) {
  const result = structuredClone(existing);
  for (const b of incoming) {
    const matches = result.filter(
      (old) =>
        normalized(old.title) === normalized(b.title) ||
        (b.titleAr &&
          old.titleAr &&
          normalized(old.titleAr) === normalized(b.titleAr)),
    );
    if (matches.length > 1)
      throw new Error(
        "Existing benefit identities are ambiguous; import stopped.",
      );
    if (matches[0]) {
      if (b.titleAr) matches[0].titleAr = b.titleAr;
    } else
      result.push({
        id: randomUUID(),
        title: b.title,
        titleAr: b.titleAr,
        completed: false,
      });
  }
  return result;
}

const matchOne = (rows, name) => {
  const matches = rows.filter(
    (r) => normalized(r.data.name) === normalized(name),
  );
  if (matches.length > 1)
    throw new Error(
      "Existing workspace identities are ambiguous; import stopped.",
    );
  return matches[0] || null;
};
export function planImport(payload, state) {
  const packageRows = structuredClone(state.packages);
  const packages = [],
    sponsors = [],
    logos = [],
    packageGuards = [];
  const summary = {
    created: 0,
    updated: 0,
    packagesCreated: 0,
    packagesUpdated: 0,
    logosAdded: 0,
    logosPreserved: 0,
    total: payload.sponsors.length,
    verified: true,
  };
  for (const s of payload.sponsors) {
    const previous = matchOne(state.sponsors, s.name);
    let row;
    if (!s.packageName) {
      if (!previous)
        throw new Error("A logo-only import requires an existing sponsor.");
      row = {
        id: previous.id,
        previous,
        data: structuredClone(previous.data),
        package_id: previous.package_id,
      };
    } else {
      let pkg = matchOne(packageRows, s.packageName);
      if (!pkg) {
        const data = packageSchema.parse({
          name: s.packageName,
          benefits: s.packageBenefits,
          benefitsAr: s.packageBenefitsAr,
          ...(s.referenceValue === undefined
            ? {}
            : { referenceValue: s.referenceValue }),
        });
        pkg = { id: randomUUID(), data };
        packages.push({ ...pkg, previous: null });
        packageRows.push(pkg);
        summary.packagesCreated++;
      } else {
        if (!packageGuards.some((p) => p.id === pkg.id)) {
          const original = state.packages.find((p) => p.id === pkg.id);
          if (original) packageGuards.push(structuredClone(original));
        }
        const old = structuredClone(pkg.data);
        const joined = mergeBenefits(
          old.benefits.map((title, i) => ({
            id: String(i),
            title,
            titleAr: old.benefitsAr?.[i] || "",
            completed: false,
          })),
          s.packageBenefits.map((title, i) => ({
            title,
            titleAr: s.packageBenefitsAr[i],
          })),
        );
        pkg.data = {
          ...old,
          benefits: joined.map((b) => b.title),
          benefitsAr: joined.map((b) => b.titleAr || ""),
        };
        // A sponsor's supplied amount is not a package's suggested price.
        if (s.referenceValue !== undefined)
          pkg.data.referenceValue = s.referenceValue;
        packageSchema.parse(pkg.data);
        if (JSON.stringify(pkg.data) !== JSON.stringify(old)) {
          const pending = packages.find((p) => p.id === pkg.id);
          if (pending) pending.data = structuredClone(pkg.data);
          else {
            packages.push({
              id: pkg.id,
              data: structuredClone(pkg.data),
              previous: state.packages.find((p) => p.id === pkg.id),
            });
            summary.packagesUpdated++;
          }
        }
      }
      const base = previous?.data || {
        name: s.name,
        packageId: pkg.id,
        contact: "",
        mobile: "",
        email: "",
        approval: "Not Approved",
        approvalDate: "",
        poIssued: false,
        poNumber: "",
        poDate: "",
        value: null,
        payments: [],
        benefits: [],
        notes: "",
      };
      const retainedBenefits = base.benefits.filter(
        (b) =>
          !s.excludedBenefits?.some(
            (excluded) => normalized(b.title) === normalized(excluded),
          ),
      );
      const data = {
        ...structuredClone(base),
        packageId: pkg.id,
        value: s.value,
        consideration: s.consideration || base.consideration || "",
        benefits: mergeBenefits(retainedBenefits, s.benefits),
      };
      sponsorSchema.parse(data);
      for (const required of s.benefits)
        if (
          !data.benefits.some(
            (b) =>
              normalized(b.title) === normalized(required.title) &&
              (!required.titleAr || b.titleAr === required.titleAr),
          )
        )
          throw new Error(
            "The imported bilingual benefits could not be verified.",
          );
      if (
        s.excludedBenefits?.some((excluded) =>
          data.benefits.some(
            (b) => normalized(b.title) === normalized(excluded),
          ),
        )
      )
        throw new Error(
          "The imported excluded benefits could not be verified.",
        );
      row = {
        id: previous?.id || randomUUID(),
        previous,
        data,
        package_id: pkg.id,
      };
    }
    const changed =
      !previous ||
      JSON.stringify(row.data) !== JSON.stringify(previous.data) ||
      row.package_id !== previous.package_id;
    row.changed = changed;
    sponsors.push(row);
    if (!previous) summary.created++;
    else if (changed) summary.updated++;
    if (s.logo) {
      const existing = state.attachments.filter(
        (a) => a.sponsor_id === row.id && a.kind === "logo",
      );
      if (existing.length > 1)
        throw new Error(
          "Existing logo identities are ambiguous; import stopped.",
        );
      if (existing.length) summary.logosPreserved++;
      else {
        logos.push({
          id: randomUUID(),
          sponsor_id: row.id,
          kind: "logo",
          name: s.logo.name,
          mime: s.logo.mime,
          size: imageBytes(s.logo).length,
          path: "import/" + randomUUID(),
          bytes: imageBytes(s.logo),
        });
        summary.logosAdded++;
      }
    }
  }
  return { packages, packageGuards, sponsors, logos, summary };
}

export function transactionSql(plan, payload, payloadHash) {
  const marker = "import:" + payload.operationId;
  const operations = [];
  const nameCount = (table, name) =>
    `(select count(*) from public.maestro_${table} where lower(btrim(data->>'name'))=lower(btrim(${sqlString(name)})))`;
  for (const p of plan.packageGuards || [])
    operations.push(
      `if ${nameCount("packages", p.data.name)} <> 1 or not exists(select 1 from public.maestro_packages where id=${sqlUuid(p.id)} and data=${sqlJson(p.data)}) then raise exception 'Import conflict'; end if;`,
    );
  for (const p of plan.packages) {
    operations.push(
      `if ${nameCount("packages", p.data.name)} <> ${p.previous ? 1 : 0} then raise exception 'Import conflict'; end if;`,
    );
    if (p.previous) {
      operations.push(
        `if not exists(select 1 from public.maestro_packages where id=${sqlUuid(p.id)} and data=${sqlJson(p.previous.data)}) then raise exception 'Import conflict'; end if;`,
      );
      operations.push(
        `update public.maestro_packages set data=${sqlJson(p.data)} where id=${sqlUuid(p.id)};`,
      );
    } else
      operations.push(
        `insert into public.maestro_packages(id,data) values(${sqlUuid(p.id)},${sqlJson(p.data)});`,
      );
  }
  for (const s of plan.sponsors) {
    operations.push(
      `if ${nameCount("sponsors", s.data.name)} <> ${s.previous ? 1 : 0} then raise exception 'Import conflict'; end if;`,
    );
    if (s.previous) {
      operations.push(
        `if not exists(select 1 from public.maestro_sponsors where id=${sqlUuid(s.id)} and revision=${s.previous.revision} and data=${sqlJson(s.previous.data)}) then raise exception 'Import conflict'; end if;`,
      );
      if (s.changed)
        operations.push(
          `update public.maestro_sponsors set data=${sqlJson(s.data)},package_id=${s.package_id ? sqlUuid(s.package_id) : "null"},revision=revision+1,updated_at=now() where id=${sqlUuid(s.id)};`,
        );
    } else
      operations.push(
        `insert into public.maestro_sponsors(id,data,package_id) values(${sqlUuid(s.id)},${sqlJson(s.data)},${s.package_id ? sqlUuid(s.package_id) : "null"});`,
      );
  }
  for (const a of plan.logos) {
    operations.push(
      `if exists(select 1 from public.maestro_attachments where sponsor_id=${sqlUuid(a.sponsor_id)} and kind='logo') then raise exception 'Import conflict'; end if;`,
    );
    operations.push(
      `insert into public.maestro_attachments(id,sponsor_id,kind,name,mime,size,path) values(${sqlUuid(a.id)},${sqlUuid(a.sponsor_id)},'logo',${sqlString(a.name)},${sqlString(a.mime)},${a.size},${sqlString(a.path)});`,
    );
    operations.push(
      `update public.maestro_sponsors set revision=revision+1,updated_at=now() where id=${sqlUuid(a.sponsor_id)};`,
    );
  }
  for (const s of plan.sponsors)
    operations.push(
      `if not exists(select 1 from public.maestro_sponsors where id=${sqlUuid(s.id)} and data=${sqlJson(s.data)} and package_id is not distinct from ${s.package_id ? sqlUuid(s.package_id) : "null"}) then raise exception 'Import verification failed'; end if;`,
    );
  for (const a of plan.logos)
    operations.push(
      `if not exists(select 1 from public.maestro_attachments where id=${sqlUuid(a.id)} and sponsor_id=${sqlUuid(a.sponsor_id)} and kind='logo' and path=${sqlString(a.path)}) then raise exception 'Import verification failed'; end if;`,
    );
  const stored = { hash: payloadHash, summary: plan.summary };
  // SQL dollar quoting is lexical: even a safely escaped string inside a DO
  // body could contain its delimiter. Pick one absent from the entire body.
  const body = operations.join("\n") + JSON.stringify(stored);
  let delimiter;
  do {
    delimiter = "$import_" + randomBytes(12).toString("hex") + "$";
  } while (body.includes(delimiter));
  return `begin;
set local standard_conforming_strings=on;
lock table public.maestro_settings,public.maestro_packages,public.maestro_sponsors,public.maestro_attachments in share row exclusive mode;
do ${delimiter}
begin
if exists(select 1 from public.maestro_settings where id=${sqlString(marker)}) then
  if not exists(select 1 from public.maestro_settings where id=${sqlString(marker)} and data->>'hash'=${sqlString(payloadHash)}) then raise exception 'Import operation conflict'; end if;
  return;
end if;
${operations.join("\n")}
insert into public.maestro_settings(id,data) values(${sqlString(marker)},${sqlJson(stored)});
end ${delimiter};
select data->'summary' as summary from public.maestro_settings where id=${sqlString(marker)};
commit;`;
}

async function run() {
  const ref = process.env.SUPABASE_PROJECT_REF,
    token = process.env.SUPABASE_ACCESS_TOKEN,
    mode = process.env.IMPORT_MODE;
  if (
    !token ||
    !/^[a-z]{20}$/.test(ref || "") ||
    !["prepare", "dry-run", "apply"].includes(mode)
  )
    throw new Error("The protected import environment is not configured.");
  const call = async (path, method = "GET", body) => {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${ref}${path}`,
      {
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(
        "The protected management operation failed (HTTP " +
          response.status +
          ").",
      );
    const responseText = await response.text();
    return responseText ? JSON.parse(responseText) : null;
  };
  const query = (sql) => call("/database/query", "POST", { query: sql });
  if (mode === "prepare") {
    const key = createImportKey();
    await query(
      `insert into public.maestro_settings(id,data) values('import-key',${sqlJson(key)}) on conflict(id) do update set data=excluded.data;`,
    );
    console.log(
      "Ephemeral public import key prepared; private key remains in the protected workspace.",
    );
    return;
  }
  const rows = await query(
    "select data from public.maestro_settings where id='import-key'",
  );
  const payload = decryptEnvelope(
    process.env.IMPORT_ENVELOPE || "",
    rows[0]?.data,
    ref,
  );
  const payloadHash = hash(JSON.stringify(payload));
  const prior = await query(
    `select data from public.maestro_settings where id=${sqlString("import:" + payload.operationId)}`,
  );
  if (prior.length) {
    if (prior[0].data.hash !== payloadHash)
      throw new Error(
        "This import operation conflicts with an existing operation.",
      );
    console.log(
      "Verified completed operation; no duplicate records or logos created.",
    );
    console.log(JSON.stringify(prior[0].data.summary));
    return;
  }
  const [packages, sponsors, attachments] = await Promise.all([
    query("select id,data from public.maestro_packages"),
    query("select id,data,package_id,revision from public.maestro_sponsors"),
    query(
      "select id,sponsor_id,kind,path from public.maestro_attachments where kind='logo'",
    ),
  ]);
  const plan = planImport(payload, { packages, sponsors, attachments });
  if (mode === "dry-run") {
    console.log(
      "Encrypted import checked; no business records or files were changed.",
    );
    console.log(JSON.stringify(plan.summary));
    return;
  }
  const uploaded = [];
  let storage;
  try {
    if (plan.logos.length) {
      const keys = await call("/api-keys?reveal=true");
      const serviceKey = keys.find(
        (k) => k.name === "service_role" && k.api_key,
      )?.api_key;
      if (!serviceKey)
        throw new Error("The protected storage credential is unavailable.");
      if (process.env.GITHUB_ACTIONS === "true")
        console.log("::add-mask::" + serviceKey);
      storage = createClient(`https://${ref}.supabase.co`, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }).storage.from("maestro-files");
      for (const logo of plan.logos) {
        const { error } = await storage.upload(logo.path, logo.bytes, {
          contentType: logo.mime,
          upsert: false,
        });
        if (error)
          throw new Error("The private logo storage operation failed.");
        uploaded.push(logo.path);
      }
    }
    const result = await query(transactionSql(plan, payload, payloadHash));
    const summary = result.find((row) => row.summary)?.summary;
    if (!summary?.verified)
      throw new Error("The committed import summary could not be verified.");
    console.log("Authorized encrypted import committed and verified.");
    console.log(JSON.stringify(summary));
  } catch (error) {
    // A lost database response can still mean a committed transaction. Recheck
    // its marker before cleaning storage so committed attachments stay intact.
    let committed,
      markerChecked = false;
    try {
      committed = (
        await query(
          `select data from public.maestro_settings where id=${sqlString("import:" + payload.operationId)} and data->>'hash'=${sqlString(payloadHash)}`,
        )
      )[0];
      markerChecked = true;
    } catch {}
    if (committed?.data?.summary?.verified) {
      console.log(
        "Authorized encrypted import verified after a transient response failure.",
      );
      console.log(JSON.stringify(committed.data.summary));
      return;
    }
    // If the database is unreachable, keep staged files until the transaction's
    // outcome can be established. An orphan is preferable to removing a file
    // that a committed attachment points to.
    if (!markerChecked) throw error;
    if (uploaded.length) {
      try {
        await storage.remove(uploaded);
      } catch {}
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch(() => {
    // Do not print provider errors, SQL, decrypted business records or key data.
    console.error(
      "Protected workspace import failed. Check the configured project, current encryption key and import schema; no plaintext details were logged.",
    );
    process.exitCode = 1;
  });
}
