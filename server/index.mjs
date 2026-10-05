import express from "express";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.DATA_DIR || "/workspace/maestro-data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const uploadDir = path.join(dataDir, "uploads");
mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(dataDir, "maestro.sqlite"));
chmodSync(path.join(dataDir, "maestro.sqlite"), 0o600);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sponsors (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS packages (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, sponsor_id TEXT REFERENCES sponsors(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, file TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
const tokenFile = path.join(dataDir, "setup-token");
if (!db.prepare("SELECT id FROM users LIMIT 1").get() && !existsSync(tokenFile))
  writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  });
  if (process.env.NODE_ENV === "production")
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
  if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.get("X-Requested-With") !== "Maestro")
      return res.status(403).json({
        error: "Request verification failed. Refresh the page and try again.",
      });
    const origin = req.get("Origin");
    if (
      origin &&
      origin !== process.env.APP_ORIGIN &&
      new URL(origin).host !== req.get("host")
    )
      return res.status(403).json({ error: "This origin is not allowed." });
  }
  next();
});
app.use(express.json({ limit: "2mb" }));
const hash = (v) => createHash("sha256").update(v).digest("hex");
const passwordHash = (p) => {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(p, salt, 64).toString("hex");
};
const verifyPassword = (p, stored) => {
  const [salt, key] = stored.split(":");
  return timingSafeEqual(scryptSync(p, salt, 64), Buffer.from(key, "hex"));
};
const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  active: !!u.active,
});
const credentials = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(200)
    .transform((v) => v.toLowerCase()),
  password: z
    .string()
    .min(12, "Use at least 12 characters for the password.")
    .max(128),
  name: z.string().trim().min(1).max(100),
});
const loginAttempts = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (entry && entry.until > now && entry.count >= 15)
    return res
      .status(429)
      .json({ error: "Too many attempts. Try again in 15 minutes." });
  if (!entry || entry.until <= now)
    loginAttempts.set(key, { count: 1, until: now + 900000 });
  else entry.count++;
  if (loginAttempts.size > 5000)
    for (const [k, v] of loginAttempts)
      if (v.until <= now) loginAttempts.delete(k);
  next();
}
function createSession(res, user) {
  const token = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
    hash(token),
    user.id,
    Date.now() + 12 * 3600000,
  );
  res.cookie("maestro_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 12 * 3600000,
    path: "/",
  });
}
app.get("/api/health", (req, res) =>
  res.json({
    status: "ok",
    setupRequired: !db.prepare("SELECT id FROM users LIMIT 1").get(),
  }),
);
app.post("/api/setup", rateLimit, (req, res) => {
  if (db.prepare("SELECT id FROM users LIMIT 1").get())
    return res
      .status(409)
      .json({ error: "Initial setup is already complete." });
  const supplied = String(req.body.token || "");
  const expected = readFileSync(tokenFile, "utf8").trim();
  if (
    !timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(hash(expected)))
  )
    return res.status(403).json({ error: "The setup token is incorrect." });
  const input = credentials.parse(req.body);
  const user = { ...input, id: randomUUID(), role: "admin", active: 1 };
  db.prepare(
    "INSERT INTO users (id,name,email,password,role) VALUES (?,?,?,?,?)",
  ).run(
    user.id,
    user.name,
    user.email,
    passwordHash(input.password),
    user.role,
  );
  unlinkSync(tokenFile);
  createSession(res, user);
  res.status(201).json(publicUser(user));
});
app.post("/api/login", rateLimit, (req, res) => {
  const input = z
    .object({
      email: z
        .string()
        .trim()
        .email()
        .transform((v) => v.toLowerCase()),
      password: z.string().min(1).max(128),
    })
    .parse(req.body);
  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(input.email);
  const valid = verifyPassword(
    input.password,
    user?.password || "00000000000000000000000000000000:" + "0".repeat(128),
  );
  if (!user || !user.active || !valid)
    return res.status(401).json({ error: "Email or password is incorrect." });
  createSession(res, user);
  loginAttempts.delete(req.ip);
  res.json(publicUser(user));
});
app.use("/api", (req, res, next) => {
  const token = req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("maestro_session="))
    ?.slice(16);
  const user =
    token &&
    db
      .prepare(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.active=1",
      )
      .get(hash(token), Date.now());
  if (!user)
    return res.status(401).json({ error: "Please sign in to continue." });
  req.user = user;
  req.sessionToken = token;
  next();
});
const edit = (req, res, next) =>
  ["admin", "editor"].includes(req.user.role)
    ? next()
    : res.status(403).json({ error: "Your account has view-only access." });
const admin = (req, res, next) =>
  req.user.role === "admin"
    ? next()
    : res.status(403).json({ error: "Administrator access is required." });
app.get("/api/me", (req, res) => res.json(publicUser(req.user)));
app.post("/api/logout", (req, res) => {
  db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(req.sessionToken));
  res.clearCookie("maestro_session", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/users", admin, (req, res) =>
  res.json(
    db.prepare("SELECT * FROM users ORDER BY name").all().map(publicUser),
  ),
);
app.post("/api/users", admin, (req, res) => {
  const input = credentials
    .extend({ role: z.enum(["admin", "editor", "viewer"]) })
    .parse(req.body);
  if (db.prepare("SELECT id FROM users WHERE email=?").get(input.email))
    return res
      .status(409)
      .json({ error: "An account with this email already exists." });
  const id = randomUUID();
  db.prepare(
    "INSERT INTO users (id,name,email,password,role) VALUES (?,?,?,?,?)",
  ).run(id, input.name, input.email, passwordHash(input.password), input.role);
  res
    .status(201)
    .json(publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(id)));
});
app.patch("/api/users/:id", admin, (req, res) => {
  const target = db
    .prepare("SELECT * FROM users WHERE id=?")
    .get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found." });
  const input = z
    .object({
      role: z.enum(["admin", "editor", "viewer"]),
      active: z.boolean(),
      password: z.string().min(12).max(128).optional(),
    })
    .parse(req.body);
  if (target.id === req.user.id && (input.role !== "admin" || !input.active))
    return res
      .status(400)
      .json({ error: "You cannot remove your own administrator access." });
  db.prepare("UPDATE users SET role=?, active=?, password=? WHERE id=?").run(
    input.role,
    Number(input.active),
    input.password ? passwordHash(input.password) : target.password,
    target.id,
  );
  if (!input.active || input.password)
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
  res.json(
    publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(target.id)),
  );
});
const benefit = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  completed: z.boolean(),
});
const money = z
  .number()
  .finite()
  .min(0)
  .max(9999999999)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001,
    "Use a maximum of two decimal places.",
  );
const date = z
  .string()
  .refine(
    (v) =>
      v === "" ||
      (/^\d{4}-\d{2}-\d{2}$/.test(v) &&
        !Number.isNaN(Date.parse(v)) &&
        new Date(v).toISOString().slice(0, 10) === v),
    "Enter a valid date.",
  );
const sponsorSchema = z.object({
  name: z.string().trim().min(1, "Sponsor Name is required.").max(200),
  packageId: z.string().uuid().or(z.literal("")),
  contact: z.string().trim().max(100),
  mobile: z
    .string()
    .trim()
    .refine(
      (v) => !v || /^\+[1-9]\d{6,14}$/.test(v),
      "Use a country code, for example +966501234567.",
    ),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .or(z.literal("")),
  approval: z.enum(["Not Approved", "In Progress", "Approved"]),
  approvalDate: date,
  poIssued: z.boolean(),
  poNumber: z.string().trim().max(100),
  poDate: date,
  value: money,
  payments: z
    .array(
      z.object({
        id: z.string().uuid(),
        amount: money.refine(
          (v) => v > 0,
          "Payment must be greater than zero.",
        ),
        date: date.refine((v) => !!v, "Payment date is required."),
        note: z.string().max(300),
      }),
    )
    .max(1000),
  benefits: z.array(benefit).max(300),
  notes: z.string().max(3000),
});
const cents = (n) => Math.round(n * 100);
const received = (s) =>
  s.payments.reduce((sum, p) => sum + cents(p.amount), 0) / 100;
function sponsor(row) {
  const s = JSON.parse(row.data);
  const pkg = db
    .prepare("SELECT data FROM packages WHERE id=?")
    .get(s.packageId);
  return {
    ...s,
    id: row.id,
    updatedAt: row.updated_at,
    revision: row.revision,
    packageName: pkg ? JSON.parse(pkg.data).name : "",
    received: received(s),
    outstanding: (cents(s.value) - cents(received(s))) / 100,
    attachments: db
      .prepare(
        "SELECT id,sponsor_id AS sponsorId,kind,name,mime,size,created_at AS createdAt FROM attachments WHERE sponsor_id=? ORDER BY created_at",
      )
      .all(row.id),
  };
}
function getSponsor(id) {
  return db.prepare("SELECT * FROM sponsors WHERE id=?").get(id);
}
function validatePackage(input) {
  if (
    input.packageId &&
    !db.prepare("SELECT id FROM packages WHERE id=?").get(input.packageId)
  ) {
    const e = new Error("Select an existing sponsorship package.");
    e.status = 400;
    throw e;
  }
}
app.get("/api/sponsors", (req, res) =>
  res.json(
    db
      .prepare("SELECT * FROM sponsors ORDER BY updated_at DESC")
      .all()
      .map(sponsor),
  ),
);
app.get("/api/sponsors/:id", (req, res) => {
  const row = getSponsor(req.params.id);
  if (!row) return res.status(404).json({ error: "Sponsor not found." });
  res.json(sponsor(row));
});
app.post("/api/sponsors", edit, (req, res) => {
  const input = sponsorSchema.parse(req.body);
  validatePackage(input);
  const id = randomUUID();
  db.prepare("INSERT INTO sponsors VALUES (?,?,?,1)").run(
    id,
    JSON.stringify(input),
    new Date().toISOString(),
  );
  res.status(201).json(sponsor(getSponsor(id)));
});
app.put("/api/sponsors/:id", edit, (req, res) => {
  const input = sponsorSchema.parse(req.body);
  validatePackage(input);
  const row = getSponsor(req.params.id);
  if (!row) return res.status(404).json({ error: "Sponsor not found." });
  if (req.body.revision !== row.revision)
    return res.status(409).json({
      error:
        "This sponsor changed since you opened it. Close and reopen the record to load the latest data before saving.",
    });
  db.prepare(
    "UPDATE sponsors SET data=?,updated_at=?,revision=revision+1 WHERE id=?",
  ).run(JSON.stringify(input), new Date().toISOString(), row.id);
  res.json(sponsor(getSponsor(row.id)));
});
app.delete("/api/sponsors/:id", edit, (req, res) => {
  if (!getSponsor(req.params.id))
    return res.status(404).json({ error: "Sponsor not found." });
  const files = db
    .prepare("SELECT file FROM attachments WHERE sponsor_id=?")
    .all(req.params.id);
  db.prepare("DELETE FROM sponsors WHERE id=?").run(req.params.id);
  for (const f of files)
    if (existsSync(path.join(uploadDir, f.file)))
      unlinkSync(path.join(uploadDir, f.file));
  res.json({ ok: true });
});
const packageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  benefits: z.array(z.string().trim().min(1).max(300)).max(100),
});
app.get("/api/packages", (req, res) =>
  res.json(
    db
      .prepare("SELECT * FROM packages")
      .all()
      .map((r) => ({ id: r.id, ...JSON.parse(r.data) })),
  ),
);
app.post("/api/packages", edit, (req, res) => {
  const input = packageSchema.parse(req.body);
  const id = randomUUID();
  db.prepare("INSERT INTO packages VALUES (?,?)").run(
    id,
    JSON.stringify(input),
  );
  res.status(201).json({ id, ...input });
});
app.put("/api/packages/:id", edit, (req, res) => {
  const input = packageSchema.parse(req.body);
  const result = db
    .prepare("UPDATE packages SET data=? WHERE id=?")
    .run(JSON.stringify(input), req.params.id);
  if (!result.changes)
    return res.status(404).json({ error: "Package not found." });
  res.json({ id: req.params.id, ...input });
});
app.delete("/api/packages/:id", edit, (req, res) => {
  if (
    db
      .prepare(
        "SELECT id FROM sponsors WHERE json_extract(data,'$.packageId')=? LIMIT 1",
      )
      .get(req.params.id)
  )
    return res.status(409).json({
      error: "This package is assigned to a sponsor and cannot be deleted.",
    });
  const result = db
    .prepare("DELETE FROM packages WHERE id=?")
    .run(req.params.id);
  if (!result.changes)
    return res.status(404).json({ error: "Package not found." });
  res.json({ ok: true });
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});
function fileType(buffer) {
  if (buffer.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return "image/jpeg";
  if (
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  const e = new Error("Upload only PNG, JPEG, WebP images or PDF documents.");
  e.status = 400;
  throw e;
}
function saveFile(file, imagesOnly = false) {
  const mime = fileType(file.buffer);
  if (imagesOnly && !mime.startsWith("image/")) {
    const e = new Error("Logos must be PNG, JPEG or WebP images.");
    e.status = 400;
    throw e;
  }
  const name =
    path
      .basename(file.originalname)
      .replace(/[\r\n\x00-\x1f]/g, "")
      .slice(0, 180) || "Attachment";
  return { mime, name, size: file.size, file: randomUUID() };
}
function writeFile(meta, file) {
  writeFileSync(path.join(uploadDir, meta.file), file.buffer, { mode: 0o600 });
}
function touch(id) {
  db.prepare(
    "UPDATE sponsors SET updated_at=?,revision=revision+1 WHERE id=?",
  ).run(new Date().toISOString(), id);
}
app.post(
  "/api/sponsors/:id/attachments",
  edit,
  upload.array("files", 10),
  (req, res) => {
    if (!getSponsor(req.params.id))
      return res.status(404).json({ error: "Sponsor not found." });
    const kind = z
      .enum(["approval", "purchase-order", "logo"])
      .parse(req.body.kind);
    if (!req.files?.length)
      return res.status(400).json({ error: "Select at least one file." });
    if (
      kind === "logo" &&
      (req.files.length !== 1 ||
        db
          .prepare(
            "SELECT id FROM attachments WHERE sponsor_id=? AND kind='logo'",
          )
          .get(req.params.id))
    )
      return res
        .status(400)
        .json({ error: "Use Replace to change an existing sponsor logo." });
    const files = req.files.map((f) => saveFile(f, kind === "logo"));
    db.exec("BEGIN");
    try {
      for (let i = 0; i < files.length; i++) {
        const m = files[i];
        writeFile(m, req.files[i]);
        db.prepare("INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?)").run(
          randomUUID(),
          req.params.id,
          kind,
          m.name,
          m.mime,
          m.size,
          m.file,
          new Date().toISOString(),
        );
      }
      touch(req.params.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      for (const m of files)
        if (existsSync(path.join(uploadDir, m.file)))
          unlinkSync(path.join(uploadDir, m.file));
      throw e;
    }
    res.status(201).json(sponsor(getSponsor(req.params.id)));
  },
);
app.get("/api/attachments/:id", (req, res) => {
  const a = db
    .prepare("SELECT * FROM attachments WHERE id=?")
    .get(req.params.id);
  if (!a) return res.status(404).json({ error: "Attachment not found." });
  res.type(a.mime);
  if (req.query.download === "1") res.attachment(a.name);
  else
    res.set(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    );
  res.sendFile(path.join(uploadDir, a.file));
});
app.post(
  "/api/attachments/:id/replace",
  edit,
  upload.single("file"),
  (req, res) => {
    const old = db
      .prepare("SELECT * FROM attachments WHERE id=?")
      .get(req.params.id);
    if (!old) return res.status(404).json({ error: "Attachment not found." });
    if (!req.file)
      return res.status(400).json({ error: "Select a replacement file." });
    const m = saveFile(req.file, old.kind === "logo");
    writeFile(m, req.file);
    db.prepare(
      "UPDATE attachments SET name=?,mime=?,size=?,file=?,created_at=? WHERE id=?",
    ).run(m.name, m.mime, m.size, m.file, new Date().toISOString(), old.id);
    touch(old.sponsor_id);
    if (existsSync(path.join(uploadDir, old.file)))
      unlinkSync(path.join(uploadDir, old.file));
    res.json(sponsor(getSponsor(old.sponsor_id)));
  },
);
app.delete("/api/attachments/:id", edit, (req, res) => {
  const a = db
    .prepare("SELECT * FROM attachments WHERE id=?")
    .get(req.params.id);
  if (!a) return res.status(404).json({ error: "Attachment not found." });
  db.prepare("DELETE FROM attachments WHERE id=?").run(a.id);
  touch(a.sponsor_id);
  if (existsSync(path.join(uploadDir, a.file)))
    unlinkSync(path.join(uploadDir, a.file));
  res.json(sponsor(getSponsor(a.sponsor_id)));
});
const brandSchema = z.object({
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  organization: z.literal("MAESTRO"),
});
const getBrand = () => {
  const row = db.prepare("SELECT data FROM settings WHERE id='brand'").get();
  return row
    ? JSON.parse(row.data)
    : { organization: "MAESTRO", accent: "#536b62", configured: false };
};
app.get("/api/brand", (req, res) => {
  const b = getBrand();
  res.json({ ...b, logoUrl: b.logo ? "/api/brand/logo" : null });
});
app.put("/api/brand", admin, (req, res) => {
  const input = brandSchema.parse(req.body);
  const old = getBrand();
  const value = { ...old, ...input, configured: true };
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('brand',?)").run(
    JSON.stringify(value),
  );
  res.json({ ...value, logoUrl: value.logo ? "/api/brand/logo" : null });
});
app.post("/api/brand/logo", admin, upload.single("file"), (req, res) => {
  if (!req.file)
    return res.status(400).json({ error: "Select an official logo." });
  const m = saveFile(req.file, true);
  const old = getBrand();
  writeFile(m, req.file);
  const value = { ...old, logo: m.file, logoMime: m.mime };
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('brand',?)").run(
    JSON.stringify(value),
  );
  if (old.logo && existsSync(path.join(uploadDir, old.logo)))
    unlinkSync(path.join(uploadDir, old.logo));
  res.json({ ...value, logoUrl: "/api/brand/logo" });
});
app.get("/api/brand/logo", (req, res) => {
  const b = getBrand();
  if (!b.logo) return res.sendStatus(404);
  res.type(b.logoMime).sendFile(path.join(uploadDir, b.logo));
});
app.delete("/api/brand/logo", admin, (req, res) => {
  const b = getBrand();
  if (b.logo && existsSync(path.join(uploadDir, b.logo)))
    unlinkSync(path.join(uploadDir, b.logo));
  delete b.logo;
  delete b.logoMime;
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('brand',?)").run(
    JSON.stringify(b),
  );
  res.json({ ...b, logoUrl: null });
});
const exportRows = (req) => {
  let list = db
    .prepare("SELECT * FROM sponsors ORDER BY updated_at DESC")
    .all()
    .map(sponsor);
  if (req.query.ids !== undefined) {
    const ids = String(req.query.ids).split(",");
    list = list.filter((s) => ids.includes(s.id));
  }
  return list;
};
const currency = (n) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
app.get("/api/export/excel", async (req, res, next) => {
  try {
    const sponsors = exportRows(req);
    const book = new ExcelJS.Workbook();
    book.creator = "MAESTRO";
    book.created = new Date();
    const sheet = book.addWorksheet("Sponsors", {
      views: [{ state: "frozen", ySplit: 4 }],
    });
    sheet.mergeCells("A1:N1");
    sheet.getCell("A1").value = "MAESTRO | Digital Government Forum";
    sheet.getCell("A1").font = { size: 20, bold: true };
    sheet.getRow(1).height = 36;
    sheet.mergeCells("A2:N2");
    sheet.getCell("A2").value = "Sponsor Management Dashboard — Currency: SAR";
    sheet.mergeCells("A3:N3");
    sheet.getCell("A3").value = "Exported: " + new Date().toISOString();
    sheet.addRow([
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
      "Total Sponsorship Value",
      "Total Received",
      "Outstanding Balance",
      "Last Updated",
    ]);
    sheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(4).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF" + getBrand().accent.slice(1) },
    };
    for (const s of sponsors)
      sheet.addRow([
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
        s.value,
        s.received,
        s.outstanding,
        s.updatedAt,
      ]);
    for (let i = 1; i <= 14; i++) sheet.getColumn(i).width = i === 1 ? 32 : 24;
    for (const col of [11, 12, 13]) sheet.getColumn(col).numFmt = "#,##0.00";
    sheet.autoFilter = "A4:N" + Math.max(4, sponsors.length + 4);
    const payments = book.addWorksheet("Payments");
    payments.addRow([
      "Sponsor Name",
      "Payment Amount (SAR)",
      "Payment Date",
      "Note",
    ]);
    for (const s of sponsors)
      for (const p of s.payments)
        payments.addRow([s.name, p.amount, p.date, p.note]);
    payments.getColumn(2).numFmt = "#,##0.00";
    payments.columns.forEach((c) => (c.width = 30));
    const benefits = book.addWorksheet("Package Benefits");
    benefits.addRow(["Sponsor Name", "Benefit", "Status"]);
    for (const s of sponsors)
      for (const b of s.benefits)
        benefits.addRow([
          s.name,
          b.title,
          b.completed ? "Completed" : "Pending",
        ]);
    benefits.columns.forEach((c) => (c.width = 35));
    const attachments = book.addWorksheet("Attachments");
    attachments.addRow(["Sponsor Name", "Section", "File Name", "Uploaded"]);
    for (const s of sponsors)
      for (const a of s.attachments)
        attachments.addRow([
          s.name,
          a.kind === "purchase-order"
            ? "Purchase Order Attachments"
            : a.kind === "approval"
              ? "Approval Attachments"
              : "Sponsor Logo",
          a.name,
          a.createdAt,
        ]);
    attachments.columns.forEach((c) => (c.width = 32));
    const brand = getBrand();
    if (brand.logo && ["image/png", "image/jpeg"].includes(brand.logoMime)) {
      const id = book.addImage({
        filename: path.join(uploadDir, brand.logo),
        extension: brand.logoMime === "image/png" ? "png" : "jpeg",
      });
      sheet.addImage(id, {
        tl: { col: 12, row: 0 },
        ext: { width: 90, height: 36 },
      });
    }
    res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment("MAESTRO-Sponsors.xlsx");
    res.send(Buffer.from(await book.xlsx.writeBuffer()));
  } catch (e) {
    next(e);
  }
});
app.get("/api/export/pdf", (req, res, next) => {
  try {
    const sponsors = exportRows(req);
    const brand = getBrand();
    const doc = new PDFDocument({
      size: "A4",
      margin: 42,
      bufferPages: true,
      info: {
        Title: "Digital Government Forum — Sponsor Management Dashboard",
        Author: "MAESTRO",
      },
    });
    res.type("application/pdf").attachment("MAESTRO-Sponsors.pdf");
    doc.on("error", next);
    doc.pipe(res);
    function heading() {
      doc
        .fillColor(brand.accent)
        .font("Helvetica-Bold")
        .fontSize(22)
        .text("MAESTRO");
      if (brand.logo && ["image/png", "image/jpeg"].includes(brand.logoMime))
        doc.image(path.join(uploadDir, brand.logo), 450, 35, { fit: [95, 38] });
      doc
        .fillColor("#222222")
        .fontSize(13)
        .text("Digital Government Forum")
        .font("Helvetica")
        .fontSize(10)
        .text("Sponsor Management Dashboard | Currency: SAR")
        .text("Exported: " + new Date().toISOString())
        .moveDown();
    }
    heading();
    const total = sponsors.reduce((a, s) => a + s.value, 0);
    const paid = sponsors.reduce((a, s) => a + s.received, 0);
    doc
      .text(
        `Total Sponsors: ${sponsors.length} | Approved Sponsors: ${sponsors.filter((s) => s.approval === "Approved").length} | Purchase Orders Issued: ${sponsors.filter((s) => s.poIssued).length}`,
      )
      .text(`Total Sponsorship Value: SAR ${currency(total)}`)
      .text(
        `Total Received: SAR ${currency(paid)} | Outstanding Balance: SAR ${currency(total - paid)}`,
      )
      .moveDown();
    if (!sponsors.length) doc.text("No sponsor records.");
    for (const s of sponsors) {
      doc.addPage();
      heading();
      doc
        .font("Helvetica-Bold")
        .fontSize(17)
        .text(s.name)
        .font("Helvetica")
        .fontSize(10)
        .moveDown();
      const lines = [
        ["Sponsorship Package", s.packageName || "Not assigned"],
        ["Contact Person", s.contact || "Not provided"],
        ["Mobile Number", s.mobile || "Not provided"],
        ["Email Address", s.email || "Not provided"],
        ["Approval Status", s.approval],
        ["Approval Date", s.approvalDate || "Not provided"],
        ["Purchase Order Issued", s.poIssued ? "Yes" : "No"],
        ["Purchase Order Number", s.poNumber || "Not provided"],
        ["Purchase Order Date", s.poDate || "Not provided"],
        ["Total Sponsorship Value", "SAR " + currency(s.value)],
        ["Total Received", "SAR " + currency(s.received)],
        ["Outstanding Balance", "SAR " + currency(s.outstanding)],
        ["Last Updated", s.updatedAt],
      ];
      for (const [label, value] of lines) doc.text(`${label}: ${value}`);
      doc
        .moveDown()
        .font("Helvetica-Bold")
        .text("Payments Received")
        .font("Helvetica");
      if (!s.payments.length) doc.text("No payments recorded.");
      for (const p of s.payments)
        doc.text(
          `${p.date} | SAR ${currency(p.amount)}${p.note ? " | " + p.note : ""}`,
        );
      doc
        .moveDown()
        .font("Helvetica-Bold")
        .text("Package Benefits")
        .font("Helvetica");
      if (!s.benefits.length) doc.text("No benefits recorded.");
      for (const b of s.benefits)
        doc.text(`${b.completed ? "Completed" : "Pending"}: ${b.title}`);
      doc
        .moveDown()
        .font("Helvetica-Bold")
        .text("Attachments")
        .font("Helvetica");
      if (!s.attachments.length) doc.text("No attachments.");
      for (const a of s.attachments)
        doc.text(
          `${a.kind === "purchase-order" ? "Purchase Order" : a.kind === "approval" ? "Approval" : "Sponsor Logo"}: ${a.name}`,
        );
      if (s.notes) doc.moveDown().text("Notes: " + s.notes);
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#666666")
        .text(`MAESTRO | Page ${i + 1} of ${range.count}`, 42, 800, {
          lineBreak: false,
        });
    }
    doc.end();
  } catch (e) {
    next(e);
  }
});
app.use("/api", (req, res) =>
  res.status(404).json({ error: "API endpoint not found." }),
);
app.use(express.static(path.join(root, "dist")));
app.get("/{*path}", (req, res) =>
  existsSync(path.join(root, "dist/index.html"))
    ? res.sendFile(path.join(root, "dist/index.html"))
    : res
        .status(503)
        .send("Build the frontend with npm run build, or use npm run dev."),
);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof z.ZodError)
    return res.status(400).json({
      error: err.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(" "),
    });
  if (err instanceof multer.MulterError)
    return res.status(400).json({
      error:
        err.code === "LIMIT_FILE_SIZE"
          ? "Each file must be 10 MB or smaller."
          : "Upload a maximum of 10 files at a time.",
    });
  if (err.status && err.status < 500)
    return res.status(err.status).json({ error: err.message });
  console.error("Request failed:", err.message);
  res
    .status(500)
    .json({ error: "The request could not be completed. Please try again." });
});
const server = app.listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || "0.0.0.0",
  () => {
    console.log(
      `MAESTRO server listening on port ${server.address().port}. Data directory: ${dataDir}`,
    );
    if (existsSync(tokenFile))
      console.log(
        `First-time administrator setup is required. Retrieve the setup token securely from ${tokenFile}.`,
      );
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
