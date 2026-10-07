import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sponsorSchema } from "../supabase/functions/maestro-api/validation.mjs";

const sponsorInput = () => ({
  name: "Booth API fixture",
  packageId: "",
  contact: "",
  mobile: "",
  email: "",
  approval: "Not Approved",
  approvalDate: "",
  poIssued: false,
  poNumber: "",
  poDate: "",
  value: 100,
  payments: [],
  benefits: [],
  notes: "",
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmP4DwQACfsD/YcUtbcAAAAASUVORK5CYII=",
  "base64",
);
const pdf = Buffer.from("%PDF-1.4\nBooth file fixture\n%%EOF");
const attachments = (
  kind,
  files = [{ name: "booth.png", bytes: png, mime: "image/png" }],
) => {
  const form = new FormData();
  form.set("kind", kind);
  for (const file of files)
    form.append(
      "files",
      new Blob([file.bytes], { type: file.mime }),
      file.name,
    );
  return form;
};

test("Cloud sponsor validation accepts optional booth dimensions and location without assuming units", () => {
  const legacy = sponsorInput();
  assert.deepEqual(sponsorSchema.parse(legacy), legacy);
  const record = sponsorSchema.parse({
    ...legacy,
    boothSize: " 6 × 4 ",
    boothLocation: " Hall A — next to the main entrance ",
  });
  assert.equal(record.boothSize, "6 × 4");
  assert.equal(record.boothLocation, "Hall A — next to the main entrance");
  for (const [field, maximum] of [
    ["boothSize", 200],
    ["boothLocation", 500],
  ]) {
    for (const invalid of [null, 42, {}, "x".repeat(maximum + 1)])
      assert.equal(
        sponsorSchema.safeParse({ ...legacy, [field]: invalid }).success,
        false,
      );
    assert.equal(sponsorSchema.parse({ ...legacy, [field]: "" })[field], "");
  }
});

test("Booth details and private attachment sections persist with existing access and ownership rules", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "maestro-booth-api-"));
  let server,
    base,
    cookie = "";
  const start = async () => {
    server = spawn(process.execPath, ["server/index.mjs"], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        PORT: "0",
        HOST: "127.0.0.1",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    base = await new Promise((resolve, reject) => {
      let output = "",
        errors = "";
      const timer = setTimeout(
        () => reject(new Error("Booth API fixture startup timed out.")),
        30000,
      );
      server.stderr.on("data", (data) => {
        errors += data;
      });
      server.stdout.on("data", (data) => {
        output += data;
        const match = output.match(/listening on port (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve("http://127.0.0.1:" + match[1]);
        }
      });
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("Booth API fixture exited: " + code + " " + errors));
      });
    });
  };
  const stop = async () => {
    if (server?.exitCode === null)
      await new Promise((resolve) => {
        server.once("exit", resolve);
        server.kill("SIGTERM");
      });
  };
  const request = (path, method = "GET", body, session = cookie) => {
    const form = body instanceof FormData;
    return fetch(base + "/api" + path, {
      method,
      headers: {
        "X-Requested-With": "Maestro",
        Cookie: session,
        ...(!form && body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
  };
  const json = async (...args) => {
    const response = await request(...args),
      result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  try {
    await start();
    const setup = await request("/setup", "POST", {
      token: await readFile(join(dir, "setup-token"), "utf8"),
      name: "Booth fixture administrator",
      email: "booth-admin@example.test",
      password: randomBytes(24).toString("hex"),
    });
    assert.equal(setup.status, 201);
    cookie = setup.headers.getSetCookie()[0].split(";")[0];
    let sponsor, location, design;
    await t.test(
      "Legacy records expose empty booth rows; explicit size and location save and edit",
      async () => {
        sponsor = await json("/sponsors", "POST", sponsorInput());
        assert.equal(sponsor.boothSize, "");
        assert.equal(sponsor.boothLocation, "");
        sponsor = await json("/sponsors/" + sponsor.id, "PUT", {
          ...sponsor,
          boothSize: " 6 × 4 m ",
          boothLocation: " Hall A, stand 14 ",
        });
        assert.equal(sponsor.boothSize, "6 × 4 m");
        assert.equal(sponsor.boothLocation, "Hall A, stand 14");
        const invalid = await request("/sponsors/" + sponsor.id, "PUT", {
          ...sponsor,
          boothSize: "x".repeat(201),
        });
        assert.equal(invalid.status, 400);
        assert.equal(
          (await json("/sponsors/" + sponsor.id)).revision,
          sponsor.revision,
        );
      },
    );
    await t.test(
      "Location images and design PDFs stay associated with their sponsor and section",
      async () => {
        sponsor = await json(
          "/sponsors/" + sponsor.id + "/attachments",
          "POST",
          attachments("booth-location"),
        );
        location = sponsor.attachments.find((a) => a.kind === "booth-location");
        assert.equal(location.sponsorId, sponsor.id);
        assert.equal(location.mime, "image/png");
        const preview = await request("/attachments/" + location.id);
        assert.equal(preview.status, 200);
        assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
        assert.match(preview.headers.get("Content-Disposition"), /^inline;/);
        const downloaded = await request(
          "/attachments/" + location.id + "?download=1",
        );
        assert.match(
          downloaded.headers.get("Content-Disposition"),
          /^attachment;/,
        );
        sponsor = await json(
          "/sponsors/" + sponsor.id + "/attachments",
          "POST",
          attachments("booth-design", [
            { name: "booth-design.pdf", bytes: pdf, mime: "application/pdf" },
            { name: "booth-render.png", bytes: png, mime: "image/png" },
          ]),
        );
        design = sponsor.attachments.find((a) => a.name === "booth-design.pdf");
        assert.equal(design.kind, "booth-design");
        assert.equal(design.sponsorId, sponsor.id);
        assert.equal(
          sponsor.attachments.filter((a) => a.kind === "booth-design").length,
          2,
        );
        const second = await json("/sponsors", "POST", {
          ...sponsorInput(),
          name: "Other booth fixture",
        });
        assert.equal(second.attachments.length, 0);
        const replace = new FormData();
        replace.set("kind", "approval"); // Ignored: replacement must retain its original section.
        replace.set("sponsorId", second.id);
        replace.set(
          "file",
          new Blob([pdf], { type: "application/pdf" }),
          "replacement-plan.pdf",
        );
        sponsor = await json(
          "/attachments/" + location.id + "/replace",
          "POST",
          replace,
        );
        location = sponsor.attachments.find((a) => a.id === location.id);
        assert.equal(location.kind, "booth-location");
        assert.equal(location.sponsorId, sponsor.id);
        assert.equal(location.name, "replacement-plan.pdf");
        assert.equal(
          (await json("/sponsors/" + second.id)).attachments.length,
          0,
        );
      },
    );
    await t.test(
      "Invalid section names and file signatures are rejected without changing the record",
      async () => {
        const revision = sponsor.revision;
        assert.equal(
          (
            await request(
              "/sponsors/" + sponsor.id + "/attachments",
              "POST",
              attachments("booth-area"),
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              "/sponsors/" + sponsor.id + "/attachments",
              "POST",
              attachments("booth-design", [
                {
                  name: "invalid.png",
                  bytes: Buffer.from("not an image"),
                  mime: "image/png",
                },
              ]),
            )
          ).status,
          400,
        );
        const current = await json("/sponsors/" + sponsor.id);
        assert.equal(current.revision, revision);
        assert.equal(current.attachments.length, 3);
        assert.equal(current.approval, "Not Approved");
        assert.equal(current.poIssued, false);
        assert.deepEqual(current.payments, []);
      },
    );
    await t.test(
      "Viewers can preview booth files but cannot upload, replace, delete or change dimensions",
      async () => {
        const password = randomBytes(24).toString("hex");
        await json("/users", "POST", {
          name: "Booth fixture viewer",
          email: "booth-viewer@example.test",
          password,
          role: "viewer",
        });
        const login = await request(
          "/login",
          "POST",
          { email: "booth-viewer@example.test", password },
          "",
        );
        assert.equal(login.status, 200);
        const viewer = login.headers.getSetCookie()[0].split(";")[0];
        assert.equal(
          (
            await request(
              "/attachments/" + location.id,
              "GET",
              undefined,
              viewer,
            )
          ).status,
          200,
        );
        assert.equal(
          (await request("/attachments/" + location.id, "GET", undefined, ""))
            .status,
          401,
        );
        assert.equal(
          (
            await request(
              "/sponsors/" + sponsor.id,
              "PUT",
              { ...sponsor, boothSize: "8 × 8" },
              viewer,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              "/sponsors/" + sponsor.id + "/attachments",
              "POST",
              attachments("booth-location"),
              viewer,
            )
          ).status,
          403,
        );
        const replace = new FormData();
        replace.set(
          "file",
          new Blob([png], { type: "image/png" }),
          "viewer.png",
        );
        assert.equal(
          (
            await request(
              "/attachments/" + location.id + "/replace",
              "POST",
              replace,
              viewer,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              "/attachments/" + design.id,
              "DELETE",
              undefined,
              viewer,
            )
          ).status,
          403,
        );
        assert.equal(
          (await json("/sponsors/" + sponsor.id)).revision,
          sponsor.revision,
        );
      },
    );
    await t.test(
      "Restart retains booth details and files; deletion affects only the selected file",
      async () => {
        await stop();
        await start();
        sponsor = await json("/sponsors/" + sponsor.id);
        assert.equal(sponsor.boothSize, "6 × 4 m");
        assert.equal(sponsor.boothLocation, "Hall A, stand 14");
        assert.equal(sponsor.attachments.length, 3);
        assert.deepEqual(
          Buffer.from(
            await (await request("/attachments/" + location.id)).arrayBuffer(),
          ),
          pdf,
        );
        sponsor = await json("/attachments/" + design.id, "DELETE");
        assert.equal(sponsor.attachments.length, 2);
        assert.equal((await request("/attachments/" + design.id)).status, 404);
        assert.equal(
          (await request("/attachments/" + location.id)).status,
          200,
        );
        assert.equal(sponsor.boothSize, "6 × 4 m");
      },
    );
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
