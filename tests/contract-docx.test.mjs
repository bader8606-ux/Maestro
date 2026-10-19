import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { zipSync, strToU8 } from "fflate";
import {
  DOCX_MIME,
  detectAttachmentType,
  validateDocx,
} from "../supabase/functions/maestro-api/document-files.mjs";

const parts = () => ({
  "[Content_Types].xml": strToU8(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  ),
  "_rels/.rels": strToU8(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  ),
  "word/document.xml": strToU8(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Original contract fixture</w:t></w:r></w:p></w:body></w:document>',
  ),
});
const fixture = () => Buffer.from(zipSync(parts()));

test("DOCX validates actual OOXML contents and remains restricted to contract attachments", () => {
  const bytes = fixture();
  assert.equal(validateDocx(bytes), DOCX_MIME);
  assert.equal(detectAttachmentType(bytes, "contract"), DOCX_MIME);
  for (const kind of [
    "quotation",
    "approval",
    "purchase-order",
    "logo",
    "booth-location",
    "booth-design",
    "",
  ])
    assert.throws(
      () => detectAttachmentType(bytes, kind),
      /only for contracts/,
    );
  const invalid = [
    Buffer.from("PK fake DOCX"),
    zipSync({ "not-a-word-file.txt": strToU8("Plain ZIP") }),
    zipSync({ ...parts(), "word/vbaProject.bin": strToU8("macro") }),
    zipSync({
      ...parts(),
      "word/document.xml": strToU8("<html>Fake Word document</html>"),
    }),
    zipSync({ ...parts(), "_rels/.rels": strToU8("<Relationships/>") }),
    zipSync({
      ...parts(),
      "[Content_Types].xml": strToU8(
        '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
      ),
    }),
    zipSync({
      ...parts(),
      "word/document.xml": strToU8(
        '<!DOCTYPE document [<!ENTITY fake "content">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
      ),
    }),
    zipSync({ ...parts(), "../outside.txt": strToU8("Unsafe path") }),
    zipSync({ ...parts(), "WORD/DOCUMENT.XML": strToU8("Duplicate part") }),
    Buffer.alloc(10 * 1024 * 1024 + 1),
    bytes.subarray(0, bytes.length - 3),
  ];
  for (const candidate of invalid)
    assert.throws(
      () => validateDocx(candidate),
      (error) => error.status === 400,
    );
});

test("DOCX validation bounds actual expansion, checks CRCs and rejects directory size lies", () => {
  const expanded = zipSync({
    ...parts(),
    "word/padding.xml": new Uint8Array(17 * 1024 * 1024),
  });
  assert.throws(() => validateDocx(expanded), /valid, unencrypted DOCX/);
  const forged = Buffer.from(expanded);
  for (let at = 0; at < forged.length - 46; at++) {
    if (forged.readUInt32LE(at) !== 0x02014b50) continue;
    const nameLength = forged.readUInt16LE(at + 28);
    if (
      forged.subarray(at + 46, at + 46 + nameLength).toString() !==
      "word/padding.xml"
    )
      continue;
    const local = forged.readUInt32LE(at + 42);
    forged.writeUInt32LE(1, at + 24);
    forged.writeUInt32LE(1, local + 22);
    break;
  }
  assert.throws(() => validateDocx(forged), /valid, unencrypted DOCX/);
  const corrupted = fixture();
  corrupted.writeUInt32LE((corrupted.readUInt32LE(14) + 1) >>> 0, 14);
  assert.throws(() => validateDocx(corrupted), /valid, unencrypted DOCX/);
});

test("Original DOCX contracts stage, download byte-for-byte and preserve sponsor/section permissions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "maestro-contract-docx-"));
  let browser;
  const server = spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const base = await new Promise((resolve, reject) => {
      let output = "",
        errors = "";
      const timer = setTimeout(
        () => reject(new Error("DOCX fixture startup timed out.")),
        30000,
      );
      server.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      server.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/listening on port (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve("http://127.0.0.1:" + match[1]);
        }
      });
      server.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("DOCX fixture exited: " + errors));
      });
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    const request = async (path, method = "GET", data) => {
      const response = await context.request.fetch(base + "/api" + path, {
        method,
        headers: { "X-Requested-With": "Maestro" },
        ...(data === undefined ? {} : { data }),
      });
      assert.equal(response.ok(), true, "Fixture request failed: " + path);
      return response.json();
    };
    await request("/setup", "POST", {
      token: await readFile(join(dir, "setup-token"), "utf8"),
      name: "Contract administrator",
      email: "contract-admin@example.test",
      password: randomBytes(24).toString("hex"),
    });
    const viewerPassword = randomBytes(24).toString("hex");
    await request("/users", "POST", {
      name: "Contract viewer",
      email: "contract-viewer@example.test",
      password: viewerPassword,
      role: "viewer",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page
      .getByRole("button", { name: "Add Sponsor", exact: true })
      .first()
      .click();
    const panel = page.getByRole("dialog").last();
    await panel
      .getByLabel("Sponsor Name", { exact: true })
      .fill("Word contract fixture");
    await panel.getByRole("tab", { name: "Attachments", exact: true }).click();
    const docx = fixture();
    const uploadFile = {
      name: "approved-contract.docx",
      mimeType: DOCX_MIME,
      buffer: docx,
    };
    let sponsor;
    await t.test(
      "Only the contract picker offers DOCX; the original staged Word file has a download-to-open preview",
      async () => {
        assert.match(
          await panel
            .getByLabel("Upload contract attachments", { exact: true })
            .getAttribute("accept"),
          /\.docx/,
        );
        assert.doesNotMatch(
          await panel
            .getByLabel("Upload quotation attachments", { exact: true })
            .getAttribute("accept"),
          /docx|wordprocessingml/,
        );
        const chooser = page.waitForEvent("filechooser");
        await panel
          .getByRole("button", {
            name: "Choose contract attachments",
            exact: true,
          })
          .click();
        await (await chooser).setFiles(uploadFile);
        await panel
          .getByRole("button", {
            name: "Preview selected approved-contract.docx",
            exact: true,
          })
          .click();
        const preview = page.getByRole("dialog", {
          name: "Preview approved-contract.docx",
          exact: true,
        });
        await preview
          .getByRole("heading", { name: "Word contract", exact: true })
          .waitFor();
        assert.equal(await preview.locator("iframe").count(), 0);
        const downloadEvent = page.waitForEvent("download");
        await preview
          .getByRole("link", { name: "Download original DOCX", exact: true })
          .click();
        const download = await downloadEvent;
        assert.deepEqual(await readFile(await download.path()), docx);
        await preview
          .getByRole("button", { name: "Close preview", exact: true })
          .click();
        await panel
          .getByRole("button", { name: "Create Sponsor", exact: true })
          .click();
        await panel
          .getByRole("button", { name: "Save Changes", exact: true })
          .waitFor();
        await panel.locator(".pending-attachment").waitFor({ state: "hidden" });
        sponsor = (await request("/sponsors"))[0];
        assert.equal(sponsor.attachments.length, 1);
        const saved = sponsor.attachments[0];
        assert.equal(saved.kind, "contract");
        assert.equal(saved.sponsorId, sponsor.id);
        assert.equal(saved.mime, DOCX_MIME);
        const response = await context.request.get(
          base + "/api/attachments/" + saved.id,
        );
        assert.match(response.headers()["content-disposition"], /^attachment;/);
        assert.deepEqual(await response.body(), docx);
        assert.equal(sponsor.approval, "Not Approved");
        assert.equal(sponsor.poIssued, false);
        assert.deepEqual(sponsor.payments, []);
      },
    );
    await t.test(
      "The API rejects fake DOCX and DOCX in every other section before any metadata is written",
      async () => {
        for (const kind of [
          "quotation",
          "approval",
          "purchase-order",
          "logo",
          "booth-location",
          "booth-design",
          "contract",
        ]) {
          const response = await context.request.post(
            base + "/api/sponsors/" + sponsor.id + "/attachments",
            {
              headers: { "X-Requested-With": "Maestro" },
              multipart: {
                kind,
                files: {
                  ...uploadFile,
                  ...(kind === "contract"
                    ? { buffer: Buffer.from("PK fake DOCX") }
                    : {}),
                },
              },
            },
          );
          assert.equal(response.status(), 400, kind);
        }
        assert.equal(
          (await request("/sponsors/" + sponsor.id)).attachments.length,
          1,
        );
      },
    );
    await t.test(
      "Replacing a contract retains its owner, kind, commitments and exact original replacement bytes",
      async () => {
        const replacement = Buffer.from(
          zipSync({
            ...parts(),
            "docProps/custom.xml": strToU8(
              '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>',
            ),
          }),
        );
        const saved = sponsor.attachments[0];
        const response = await context.request.post(
          base + "/api/attachments/" + saved.id + "/replace",
          {
            headers: { "X-Requested-With": "Maestro" },
            multipart: {
              file: {
                name: "contract-revised.docx",
                mimeType: DOCX_MIME,
                buffer: replacement,
              },
            },
          },
        );
        assert.equal(response.status(), 200);
        const after = await response.json();
        assert.equal(after.attachments[0].id, saved.id);
        assert.equal(after.attachments[0].sponsorId, sponsor.id);
        assert.equal(after.attachments[0].kind, "contract");
        for (const field of [
          "value",
          "approval",
          "poIssued",
          "payments",
          "benefits",
          "packageId",
        ])
          assert.deepEqual(after[field], sponsor[field]);
        assert.deepEqual(
          await (
            await context.request.get(
              base + "/api/attachments/" + saved.id + "?download=1",
            )
          ).body(),
          replacement,
        );
      },
    );
    await t.test(
      "Viewers can download original Word contracts but cannot upload/replace/delete; anonymous downloads require login",
      async () => {
        const viewer = await browser.newContext();
        const login = await viewer.request.post(base + "/api/login", {
          headers: { "X-Requested-With": "Maestro" },
          data: {
            email: "contract-viewer@example.test",
            password: viewerPassword,
          },
        });
        assert.equal(login.ok(), true);
        const saved = (await request("/sponsors/" + sponsor.id)).attachments[0];
        assert.equal(
          (
            await viewer.request.get(base + "/api/attachments/" + saved.id)
          ).status(),
          200,
        );
        for (const path of [
          "/sponsors/" + sponsor.id + "/attachments",
          "/attachments/" + saved.id + "/replace",
        ])
          assert.equal(
            (
              await viewer.request.post(base + "/api" + path, {
                headers: { "X-Requested-With": "Maestro" },
                multipart: { kind: "contract", files: uploadFile },
              })
            ).status(),
            403,
          );
        assert.equal(
          (
            await viewer.request.delete(base + "/api/attachments/" + saved.id, {
              headers: { "X-Requested-With": "Maestro" },
            })
          ).status(),
          403,
        );
        const anonymous = await browser.newContext();
        assert.equal(
          (
            await anonymous.request.get(base + "/api/attachments/" + saved.id)
          ).status(),
          401,
        );
        await anonymous.close();
        await viewer.close();
      },
    );
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null)
      await new Promise((resolve) => {
        server.once("exit", resolve);
        server.kill("SIGTERM");
      });
    await rm(dir, { recursive: true, force: true });
  }
});
