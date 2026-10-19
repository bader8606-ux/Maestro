import { Inflate } from "fflate";

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const invalid = () => {
  throw Object.assign(
    new Error(
      "Upload a valid, unencrypted DOCX contract without macros (10 MB maximum).",
    ),
    { status: 400 },
  );
};
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
const decode = new TextDecoder("utf-8", { fatal: true });
const maxEntry = 16 * 1024 * 1024;
const maxExpanded = 48 * 1024 * 1024;

/** Validate the original OOXML package without rewriting its bytes. */
export function validateDocx(bytes) {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length < 22 ||
      bytes.length > 10 * 1024 * 1024
    )
      invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (at) => view.getUint16(at, true);
    const u32 = (at) => view.getUint32(at, true);
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50)
      end--;
    if (
      end < 0 ||
      u32(end) !== 0x06054b50 ||
      end + 22 + u16(end + 20) !== bytes.length
    )
      invalid();
    const count = u16(end + 10),
      centralSize = u32(end + 12),
      centralStart = u32(end + 16);
    if (
      u16(end + 4) ||
      u16(end + 6) ||
      count !== u16(end + 8) ||
      !count ||
      count > 512 ||
      centralStart + centralSize !== end
    )
      invalid();
    const names = new Set(),
      ranges = [],
      xml = {};
    let cursor = centralStart,
      expanded = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || u32(cursor) !== 0x02014b50) invalid();
      const flags = u16(cursor + 8),
        method = u16(cursor + 10),
        crc = u32(cursor + 16),
        compressedSize = u32(cursor + 20),
        size = u32(cursor + 24),
        nameSize = u16(cursor + 28),
        next = cursor + 46 + nameSize + u16(cursor + 30) + u16(cursor + 32),
        local = u32(cursor + 42);
      if (
        flags & 0x2041 ||
        ![0, 8].includes(method) ||
        u16(cursor + 34) ||
        next > end ||
        !nameSize ||
        nameSize > 512 ||
        size > maxEntry ||
        (expanded += size) > maxExpanded
      )
        invalid();
      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize),
        name = decode.decode(nameBytes);
      if (
        names.has(name.toLowerCase()) ||
        /(^\/|\\|\0|(^|\/)\.\.?($|\/))/.test(name) ||
        /(?:vbaProject|vbaData|\.docm$|\.dotm$)/i.test(name)
      )
        invalid();
      names.add(name.toLowerCase());
      if (
        local + 30 > centralStart ||
        u32(local) !== 0x04034b50 ||
        u16(local + 6) !== flags ||
        u16(local + 8) !== method ||
        u16(local + 26) !== nameSize
      )
        invalid();
      const dataStart = local + 30 + nameSize + u16(local + 28),
        dataEnd = dataStart + compressedSize;
      if (
        dataEnd > centralStart ||
        dataStart > dataEnd ||
        decode.decode(bytes.subarray(local + 30, local + 30 + nameSize)) !==
          name ||
        (!(flags & 8) &&
          (u32(local + 14) !== crc ||
            u32(local + 18) !== compressedSize ||
            u32(local + 22) !== size))
      )
        invalid();
      ranges.push([local, dataEnd]);
      const textPart = [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
      ].includes(name);
      if (textPart && size > 4 * 1024 * 1024) invalid();
      const chunks = [];
      let actual = 0,
        checksum = 0xffffffff;
      const receive = (chunk) => {
        actual += chunk.length;
        if (actual > size || actual > maxEntry) invalid();
        for (const byte of chunk)
          checksum = (checksum >>> 8) ^ crcTable[(checksum ^ byte) & 255];
        if (textPart) chunks.push(chunk);
      };
      if (method === 0) receive(bytes.subarray(dataStart, dataEnd));
      else {
        // Small compressed chunks bound the output allocated before each limit check,
        // including archives that lie about their expanded size in the directory.
        const stream = new Inflate(receive);
        for (let at = dataStart; at < dataEnd; at += 1024)
          stream.push(
            bytes.subarray(at, Math.min(at + 1024, dataEnd)),
            at + 1024 >= dataEnd,
          );
        if (!compressedSize) invalid();
      }
      if (actual !== size || (checksum ^ 0xffffffff) >>> 0 !== crc) invalid();
      if (textPart) {
        const content = new Uint8Array(actual);
        let offset = 0;
        for (const chunk of chunks) {
          content.set(chunk, offset);
          offset += chunk.length;
        }
        xml[name] = decode.decode(content);
        if (/<!DOCTYPE|<!ENTITY/i.test(xml[name])) invalid();
      }
      cursor = next;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    if (
      cursor !== end ||
      ranges[0][0] !== 0 ||
      ranges.some((range, i) => i && range[0] < ranges[i - 1][1])
    )
      invalid();
    const types = xml["[Content_Types].xml"],
      relationships = xml["_rels/.rels"],
      document = xml["word/document.xml"];
    if (
      !types ||
      !relationships ||
      !document ||
      /macroEnabled|vbaProject/i.test(types)
    )
      invalid();
    const overrides = types.match(/<(?:\w+:)?Override\b[^>]*>/g) || [];
    if (
      !overrides.some(
        (tag) =>
          /\bPartName\s*=\s*["']\/word\/document\.xml["']/.test(tag) &&
          /\bContentType\s*=\s*["']application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml["']/.test(
            tag,
          ),
      )
    )
      invalid();
    const officeRelationships =
      relationships.match(/<(?:\w+:)?Relationship\b[^>]*>/g) || [];
    if (
      !officeRelationships.some(
        (tag) =>
          /\bType\s*=\s*["']http:\/\/(?:schemas\.openxmlformats\.org\/officeDocument\/2006|purl\.oclc\.org\/ooxml\/officeDocument)\/relationships\/officeDocument["']/.test(
            tag,
          ) &&
          /\bTarget\s*=\s*["']\/?word\/document\.xml["']/.test(tag) &&
          !/\bTargetMode\s*=\s*["']External["']/i.test(tag),
      )
    )
      invalid();
    if (
      !/<(?:\w+:)?document\b/.test(document) ||
      !/xmlns(?::\w+)?\s*=\s*["']http:\/\/(?:schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|purl\.oclc\.org\/ooxml\/wordprocessingml\/main)["']/.test(
        document,
      )
    )
      invalid();
    return DOCX_MIME;
  } catch {
    invalid();
  }
}

export function detectAttachmentType(bytes, kind = "") {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  const signature = new TextDecoder().decode(bytes.subarray(0, 16));
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP")
    return "image/webp";
  if (signature.startsWith("%PDF-")) return "application/pdf";
  if (kind === "contract") return validateDocx(bytes);
  throw Object.assign(
    new Error(
      "Upload a PNG, JPEG, WebP image or PDF document. DOCX is supported only for contracts.",
    ),
    { status: 400 },
  );
}
