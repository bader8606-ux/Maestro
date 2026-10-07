import { z } from "zod";
import {
  sponsorSchema,
  packageSchema,
  userSchema,
  accessSchema,
} from "./validation.mjs";
import { reports } from "./reports.mjs";
import { resolveBrand, officialLogoUrl } from "./brand.mjs";
import { publicImportKey } from "./import-key.mjs";
const bucket = "maestro-files";
/** @returns {never} */
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
const checked = async (query) => {
  const { data, error } = await query;
  if (error)
    fail(
      error.code === "23503"
        ? "This package is assigned to a sponsor."
        : error.code === "23505"
          ? "This record already exists."
          : "The operation could not be saved. Please try again.",
      409,
    );
  return data;
};
const table = (db, name) => db.from("maestro_" + name);
export function fileType(bytes) {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 13 &&
    bytes[5] === 10 &&
    bytes[6] === 26 &&
    bytes[7] === 10
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  const s = new TextDecoder().decode(bytes);
  if (s.startsWith("RIFF") && s.slice(8, 12) === "WEBP") return "image/webp";
  if (s.startsWith("%PDF-")) return "application/pdf";
  fail("Upload a PNG, JPEG, WebP image or PDF document.");
}
/** @param {any} db @param {{origins?: string[]}} options @returns {(req: Request) => Promise<Response>} */
export function createHandler(db, { origins = [] } = {}) {
  const storage = db.storage.from(bucket);
  const signed = async (path) => {
    if (!path) return null;
    const { data, error } = await storage.createSignedUrl(path, 3600);
    if (error) fail("File preview is unavailable.", 503);
    return data.signedUrl;
  };
  const brand = async () => {
    const row = await checked(
      table(db, "settings").select("data").eq("id", "brand").single(),
    );
    const { logoPath, logoMime, ...data } = row.data;
    return {
      ...resolveBrand(data),
      logoUrl: logoPath ? await signed(logoPath) : officialLogoUrl,
      logoIsDefault: !logoPath,
    };
  };
  const list = async (factory) => {
    const result = [];
    let offset = 0;
    for (;;) {
      const { data, error, count } = await factory().range(
        offset,
        offset + 999,
      );
      if (error) fail("Records could not be loaded. Please try again.", 503);
      result.push(...data);
      offset += data.length;
      if (!data.length || offset >= count) return result;
    }
  };
  const sponsors = async (id) => {
    const [rows, packages, attachments] = await Promise.all([
      list(() => {
        let q = table(db, "sponsors")
          .select("*", { count: "exact" })
          .order("updated_at", { ascending: false })
          .order("id");
        return id ? q.eq("id", id) : q;
      }),
      list(() =>
        table(db, "packages").select("*", { count: "exact" }).order("id"),
      ),
      list(() => {
        const q = table(db, "attachments")
          .select("*", { count: "exact" })
          .order("id");
        return id ? q.eq("sponsor_id", id) : q;
      }),
    ]);
    if (id && !rows.length) fail("Sponsor not found.", 404);
    const files = await Promise.all(
      attachments.map(async (a) => ({
        id: a.id,
        sponsorId: a.sponsor_id,
        kind: a.kind,
        name: a.name,
        mime: a.mime,
        size: a.size,
        createdAt: a.created_at,
        url: await signed(a.path),
      })),
    );
    return rows.map((r) => {
      const s = r.data;
      const received =
        s.payments.reduce((n, p) => n + Math.round(p.amount * 100), 0) / 100;
      return {
        ...s,
        boothSize: s.boothSize || "",
        boothLocation: s.boothLocation || "",
        id: r.id,
        revision: r.revision,
        updatedAt: r.updated_at,
        packageName:
          packages.find((p) => p.id === r.package_id)?.data.name || "",
        received,
        outstanding:
          s.value === null
            ? null
            : (Math.round(s.value * 100) - Math.round(received * 100)) / 100,
        attachments: files.filter((a) => a.sponsorId === r.id),
      };
    });
  };
  const one = async (id) => (await sponsors(id))[0];
  const upload = async (file, images = false) => {
    if (!(file instanceof Blob) || !file.size || file.size > 10 * 1024 * 1024)
      fail("Each file must be between 1 byte and 10 MB.");
    const mime = fileType(
      new Uint8Array(await file.slice(0, 16).arrayBuffer()),
    );
    if (images && mime === "application/pdf") fail("A logo must be an image.");
    const path = crypto.randomUUID();
    await checked(
      storage.upload(path, file, { contentType: mime, upsert: false }),
    );
    return {
      path,
      mime,
      size: file.size,
      name: (file.name || "attachment").slice(0, 240),
    };
  };
  const touch = async (id) =>
    checked(db.rpc("maestro_touch_sponsor", { sponsor: id }));
  return async function handle(req) {
    const origin = req.headers.get("Origin");
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    };
    if (origin && origins.includes(origin))
      Object.assign(headers, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers":
          "authorization, apikey, content-type, x-requested-with",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      });
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    try {
      if (origin && !origins.includes(origin))
        fail("This origin is not allowed.", 403);
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      const url = new URL(req.url),
        path = url.pathname.replace(/^.*\/maestro-api/, "");
      const parts = path.split("/").filter(Boolean),
        [route, id, action] = parts;
      const method = req.method;
      if (path === "/health" && method === "GET") {
        await checked(
          table(db, "settings").select("id").eq("id", "brand").single(),
        );
        return json({ setupRequired: false, storage: "Supabase" });
      }
      if (path === "/import-key" && method === "GET") {
        const key = await publicImportKey(db);
        if (!key) fail("Workspace import key is unavailable.", 404);
        return json(key);
      }
      const token = req.headers
        .get("Authorization")
        ?.match(/^Bearer (.+)$/i)?.[1];
      if (!token) fail("Please sign in to continue.", 401);
      const { data: auth, error: authError } = await db.auth.getUser(token);
      if (authError || !auth.user)
        fail("Your session expired. Please sign in again.", 401);
      const { data: user, error: profileError } = await table(db, "profiles")
        .select("*")
        .eq("id", auth.user.id)
        .maybeSingle();
      if (profileError || !user || !user.active)
        fail("Your account does not have access to this workspace.", 403);
      // getUser verifies the JWT signature above; iat is used only for revocation.
      const claims = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
          ),
        ),
      );
      if (user.invalid_before && Number(claims.iat) <= user.invalid_before)
        fail("Your session expired. Please sign in again.", 401);
      if (
        !claims.session_id ||
        !(await checked(
          db.rpc("maestro_session_is_current", {
            account: user.id,
            session: claims.session_id,
          }),
        ))
      )
        fail("Your session expired. Please sign in again.", 401);
      const publicUser = ({ id, name, email, role, active }) => ({
        id,
        name,
        email,
        role,
        active,
      });
      const admin = () => {
        if (user.role !== "admin")
          fail("Administrator access is required.", 403);
      };
      const edit = () => {
        if (user.role === "viewer") fail("You have view-only access.", 403);
      };
      const body = async () => {
        const length = Number(req.headers.get("Content-Length") || 0);
        if (length > 2 * 1024 * 1024) fail("The record is too large.", 413);
        return req.json();
      };
      if (path === "/me" && method === "GET") return json(publicUser(user));
      if (route === "sponsors") {
        if (method === "GET")
          return json(id ? await one(id) : await sponsors());
        edit();
        if ((!id && method === "POST") || (id && method === "PUT" && !action)) {
          const input = await body(),
            data = sponsorSchema.parse(input);
          if (data.packageId) {
            const p = await checked(
              table(db, "packages")
                .select("id")
                .eq("id", data.packageId)
                .maybeSingle(),
            );
            if (!p) fail("Select an existing sponsorship package.");
          }
          const values = { data, package_id: data.packageId || null };
          if (!id) {
            const row = await checked(
              table(db, "sponsors").insert(values).select("id").single(),
            );
            return json(await one(row.id), 201);
          }
          const revision = z.number().int().positive().parse(input.revision);
          const row = await checked(
            table(db, "sponsors")
              .update({
                ...values,
                revision: revision + 1,
                updated_at: new Date().toISOString(),
              })
              .eq("id", id)
              .eq("revision", revision)
              .select("id")
              .maybeSingle(),
          );
          if (!row)
            fail(
              "This sponsor changed since you opened it. Close and reopen the record before saving.",
              409,
            );
          return json(await one(id));
        }
        if (id && method === "DELETE" && !action) {
          await one(id);
          const files = await checked(
            table(db, "attachments").select("path").eq("sponsor_id", id),
          );
          await checked(table(db, "sponsors").delete().eq("id", id));
          if (files.length)
            await checked(storage.remove(files.map((f) => f.path)));
          return json({ ok: true });
        }
        if (id && action === "attachments" && method === "POST") {
          await one(id);
          const form = await req.formData(),
            kind = z
              .enum([
                "approval",
                "purchase-order",
                "logo",
                "booth-location",
                "booth-design",
              ])
              .parse(form.get("kind"));
          const files = form.getAll("files");
          if (
            !files.length ||
            files.length > 10 ||
            (kind === "logo" && files.length !== 1)
          )
            fail("Upload between 1 and 10 files, or one sponsor logo.");
          const created = [];
          try {
            for (const file of files)
              created.push(await upload(file, kind === "logo"));
            await checked(
              table(db, "attachments").insert(
                created.map((f) => ({ ...f, kind, sponsor_id: id })),
              ),
            );
          } catch (e) {
            if (created.length)
              await storage.remove(created.map((f) => f.path));
            throw e;
          }
          await touch(id);
          return json(await one(id));
        }
      }
      if (route === "attachments" && id) {
        edit();
        const a = await checked(
          table(db, "attachments").select("*").eq("id", id).maybeSingle(),
        );
        if (!a) fail("Attachment not found.", 404);
        if (action === "replace" && method === "POST") {
          const form = await req.formData(),
            file = await upload(form.get("file"), a.kind === "logo");
          try {
            await checked(
              table(db, "attachments")
                .update({ ...file, created_at: new Date().toISOString() })
                .eq("id", id),
            );
          } catch (e) {
            await storage.remove([file.path]);
            throw e;
          }
          await checked(storage.remove([a.path]));
          await touch(a.sponsor_id);
          return json(await one(a.sponsor_id));
        }
        if (method === "DELETE" && !action) {
          await checked(table(db, "attachments").delete().eq("id", id));
          await checked(storage.remove([a.path]));
          await touch(a.sponsor_id);
          return json(await one(a.sponsor_id));
        }
      }
      if (route === "packages") {
        if (method === "GET" && !id)
          return json(
            (
              await list(() =>
                table(db, "packages")
                  .select("*", { count: "exact" })
                  .order("id"),
              )
            ).map((r) => ({
              ...r.data,
              id: r.id,
            })),
          );
        edit();
        if ((method === "POST" && !id) || (method === "PUT" && id)) {
          const data = packageSchema.parse(await body());
          const q = id
            ? table(db, "packages").update({ data }).eq("id", id)
            : table(db, "packages").insert({ data });
          const row = await checked(q.select("*").single());
          return json({ ...row.data, id: row.id });
        }
        if (method === "DELETE" && id) {
          await checked(table(db, "packages").delete().eq("id", id));
          return json({ ok: true });
        }
      }
      if (route === "users") {
        admin();
        if (method === "GET" && !id)
          return json(
            (
              await list(() =>
                table(db, "profiles")
                  .select("*", { count: "exact" })
                  .order("name")
                  .order("id"),
              )
            ).map(publicUser),
          );
        if (method === "POST" && !id) {
          const input = userSchema.parse(await body());
          const { data, error } = await db.auth.admin.createUser({
            email: input.email,
            password: input.password,
            email_confirm: true,
          });
          if (error)
            fail(
              "The account could not be created. Check the email and password.",
            );
          try {
            await checked(
              table(db, "profiles").insert({
                id: data.user.id,
                name: input.name,
                email: input.email,
                role: input.role,
              }),
            );
          } catch (e) {
            await db.auth.admin.deleteUser(data.user.id);
            throw e;
          }
          return json(
            {
              id: data.user.id,
              ...publicUser({ ...input, id: data.user.id, active: true }),
            },
            201,
          );
        }
        if (method === "PATCH" && id) {
          const input = accessSchema.parse(await body());
          if (id === user.id && (input.role !== "admin" || !input.active))
            fail("You cannot remove your own administrator access.");
          const existing = await checked(
            table(db, "profiles").select("id").eq("id", id).maybeSingle(),
          );
          if (!existing) fail("Team member not found.", 404);
          // Revoke application access before changing authentication credentials.
          const invalid_before =
            input.password || !input.active
              ? Math.floor(Date.now() / 1000)
              : undefined;
          await checked(
            table(db, "profiles")
              .update({
                role: input.role,
                active: input.active,
                ...(invalid_before ? { invalid_before } : {}),
              })
              .eq("id", id),
          );
          if (invalid_before)
            await checked(db.rpc("maestro_revoke_sessions", { account: id }));
          const { error } = await db.auth.admin.updateUserById(id, {
            ban_duration: input.active ? "none" : "876000h",
            ...(input.password ? { password: input.password } : {}),
          });
          if (error)
            fail(
              "Access was updated, but the password change failed. Please retry.",
              503,
            );
          return json({ ok: true });
        }
      }
      if (route === "brand") {
        if (method === "GET" && !id) return json(await brand());
        admin();
        const current = await checked(
          table(db, "settings").select("data").eq("id", "brand").single(),
        );
        if (method === "PUT" && !id) {
          const input = z
            .object({ accent: z.string().regex(/^#[0-9a-f]{6}$/i) })
            .parse(await body());
          await checked(
            table(db, "settings")
              .update({ data: { ...current.data, ...input, configured: true } })
              .eq("id", "brand"),
          );
          return json(await brand());
        }
        if (id === "logo" && method === "POST") {
          const form = await req.formData(),
            f = await upload(form.get("file"), true);
          try {
            await checked(
              table(db, "settings")
                .update({
                  data: { ...current.data, logoPath: f.path, logoMime: f.mime },
                })
                .eq("id", "brand"),
            );
          } catch (e) {
            await storage.remove([f.path]);
            throw e;
          }
          if (current.data.logoPath)
            await checked(storage.remove([current.data.logoPath]));
          return json(await brand());
        }
        if (id === "logo" && method === "DELETE") {
          const { logoPath, logoMime, ...data } = current.data;
          await checked(
            table(db, "settings").update({ data }).eq("id", "brand"),
          );
          if (logoPath) await checked(storage.remove([logoPath]));
          return json(await brand());
        }
      }
      if (
        route === "export" &&
        ["excel", "pdf"].includes(id) &&
        method === "GET"
      ) {
        const ids = url.searchParams.get("ids");
        const selected =
          ids === null
            ? await sponsors()
            : (await sponsors()).filter((s) => ids.split(",").includes(s.id));
        const b = await brand();
        const report = await reports(id, selected, b);
        return new Response(report.bytes, {
          headers: {
            ...headers,
            "Content-Type": report.mime,
            "Content-Disposition": `attachment; filename="MAESTRO-Sponsors.${id === "excel" ? "xlsx" : "pdf"}"`,
          },
        });
      }
      fail("This operation is not available.", 404);
    } catch (e) {
      return json(
        {
          error:
            e instanceof z.ZodError
              ? e.issues[0].message
              : e.status
                ? e.message
                : "The workspace is unavailable. Please try again.",
        },
        e instanceof z.ZodError ? 400 : e.status || 500,
      );
    }
  };
}
