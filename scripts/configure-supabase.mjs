// Run in GitHub Actions or the cloud terminal with secure environment bindings.
// Uses an existing project only; it never creates or upgrades a paid resource.
import { readFile, readdir, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const token = process.env.SUPABASE_ACCESS_TOKEN,
  ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref || !/^[a-z]{20}$/.test(ref))
  throw new Error(
    "Set SUPABASE_ACCESS_TOKEN securely and a valid SUPABASE_PROJECT_REF.",
  );
const origin =
  process.env.MAESTRO_PAGE_ORIGIN || "https://bader8606-ux.github.io";
const page = process.env.MAESTRO_PAGE_URL || origin + "/Maestro/";
if (new URL(origin).origin !== origin || new URL(page).origin !== origin)
  throw new Error("The page URL must match its HTTPS origin.");
if (!origin.startsWith("https://"))
  throw new Error("Use HTTPS for public hosting.");
async function call(path, method = "GET", body) {
  const res = await fetch(
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
  if (!res.ok)
    throw new Error(
      `Supabase configuration failed (${res.status}) while applying ${path}. Check project access and retry.`,
    );
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const query = async (sql, parameters = []) =>
  call("/database/query", "POST", { query: sql, parameters });
await query(
  "create table if not exists public.maestro_migrations (version text primary key, hash text not null); alter table public.maestro_migrations enable row level security; revoke all on public.maestro_migrations from anon,authenticated;",
);
const applied = await query(
  "select version,hash from public.maestro_migrations",
);
const dir = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
for (const name of (await readdir(dir))
  .filter((n) => n.endsWith(".sql"))
  .sort()) {
  const sql = await readFile(dir + name, "utf8"),
    hash = createHash("sha256").update(sql).digest("hex");
  const existing = applied.find((r) => r.version === name);
  if (existing) {
    if (existing.hash !== hash)
      throw new Error(
        "An applied migration changed. Add a new migration instead.",
      );
    continue;
  }
  await query(
    `begin; ${sql}\n insert into public.maestro_migrations(version,hash) values ('${name}','${hash}'); commit;`,
  );
  console.log("Applied migration:", name);
}
await call("/config/auth", "PATCH", {
  disable_signup: true,
  external_email_enabled: true,
  site_url: page,
  jwt_exp: 3600,
  password_min_length: 12,
});
await call("/secrets", "POST", [{ name: "ALLOWED_ORIGINS", value: origin }]);
const keys = await call("/api-keys?reveal=true");
const publicKey =
  keys.find((k) => k.type === "publishable" && k.api_key)?.api_key ||
  keys.find((k) => k.name === "anon" && k.api_key)?.api_key;
if (!publicKey || publicKey.startsWith("sb_secret_"))
  throw new Error("No public publishable/anon key is available.");
const url = `https://${ref}.supabase.co`;
if (process.env.GITHUB_ENV)
  await appendFile(
    process.env.GITHUB_ENV,
    `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_PUBLISHABLE_KEY=${publicKey}\n`,
  );
console.log(
  "Supabase schema, private storage and authentication configured. No administrator or sponsor records were created.",
);
