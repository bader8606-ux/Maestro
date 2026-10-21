# Authorized workspace imports

The repository is public. Private sponsor records, amounts, contact details and
uploaded files must stay outside source files and plaintext workflow inputs.
The manual **Import authorized workspace records** workflow imports only an
owner-authorized payload into the existing Supabase project. It uses the same
repository `SUPABASE_PROJECT_REF` variable and `SUPABASE_ACCESS_TOKEN` secret as
deployment; it does not create or upgrade any hosting resource.

1. Deploy the current API, then dispatch `workspace-import.yml` in `prepare` mode.
   The workflow creates a two-hour RSA key in the restricted settings table.
2. Read `/functions/v1/maestro-api/import-key` over verified HTTPS. The endpoint
   exposes only the public key, key ID and expiry, never the private key or records.
3. Keep the supplied records in an owner-only temporary file. Call the exported
   `validatePayload` and `encryptEnvelope` helpers in `scripts/workspace-import.mjs`.
   The encrypted envelope uses RSA-OAEP-SHA256 and AES-256-GCM, binds the project
   and key IDs, and fits the workflow's 60 KB input limit.
4. Dispatch `dry-run` with the ciphertext, inspect the aggregate creation/update
   counts, then dispatch `apply` for already authorized changes. Never enter
   plaintext business records or credentials in workflow inputs. Embedded logo
   bytes must be verified originals, not generated artwork. Separate small logo
   imports must still fit the full envelope limit. Original PDF quotations and
   PDF/DOCX contracts use protected chunk staging below when they exceed that limit.

## Original PDF quotations

Quotation imports require an existing, unambiguous sponsor. They add only private
`quotation` attachments; every sponsor field, package, benefit, independent
approval/PO state and payment remains unchanged. An added attachment updates the
record's revision and Last Updated time. Quotations are never filed as purchase
orders or approval evidence.

Use a single current public key, project reference and operation UUID for the
whole batch. The exported helper accepts original PDF bytes as a Buffer:

```js
const { quotation, stages } = buildQuotationStages({
  projectRef,
  operationId,
  sponsorName,
  fileName, // original filename, with a .pdf extension
  bytes, // original bytes; do not regenerate or recompress the PDF
});
```

For each item in `stages`, call `encryptEnvelope(stage, publicKey)` locally and
dispatch the workflow with `mode: "stage"` and only that encrypted envelope.
The helper uses 32,000-byte chunks whose authenticated envelopes remain below
60 KB even for incompressible bytes. Successful stage runs store immutable
chunks in the restricted settings table, bound to the project, key, operation,
sponsor, file ID, filename, checksum, size, chunk count and index. Staging does
not change sponsor records or create visible attachments. A repeated identical
chunk is safe; changed content at the same identity stops the import. Chunks
expire with the two-hour import key; the next `prepare` removes expired chunks.

Then encrypt and dispatch `dry-run` and `apply` using this final payload shape:

```js
{
  version: 1,
  projectRef,
  operationId,
  sponsors: [{ name: sponsorName, quotations: [quotation] }]
}
```

One batch can contain at most ten original PDFs, each no larger than 10 MB.
Descriptors contain `fileId`, `name`, `mime: "application/pdf"`, `sha256`, `size`
and `total`; they contain no file bytes. The runner assembles all chunks, checks
their ownership, count, expiry, exact length, PDF signature and SHA-256, then
checks existing private quotation contents for byte-identical duplicates. An
identical file already attached to that sponsor is preserved. Files belonging
to another sponsor cannot suppress or receive the import.

Each new private upload is downloaded again and checked against the original
checksum before metadata is committed. The transaction checks the sponsor
revision, full data and package association, as well as the existing quotation
metadata snapshot. Concurrent changes stop the operation and clean only its
uncommitted private uploads. It verifies the saved metadata, writes the private
replay marker, and removes that operation's staged chunks atomically. Replaying
the same committed operation cannot create duplicate attachments. Logs contain
only generic success messages and aggregate counts, never filenames, original
bytes, chunks, decrypted records, SQL or credentials. Remove owner-only local
plaintext and ciphertext temporary files after the verified import.

## Original PDF and DOCX contracts

Contract imports use the same protected staging procedure and require an existing,
unambiguous sponsor. They add only private `contract` attachments. They do not
change sponsorship values, package definitions, benefits, contacts, notes,
approval/PO statuses, approval dates or payments. Uploading a file does not assert
that it has been signed, legally approved, or paid.

```js
const { contract, stages } = buildContractStages({
  projectRef,
  operationId,
  sponsorName,
  fileName, // exact original .pdf or .docx filename
  bytes, // original bytes; no conversion or regeneration
});
// Encrypt/stage every item, then dry-run and apply this final manifest:
const payload = {
  version: 1,
  projectRef,
  operationId,
  sponsors: [{ name: sponsorName, contracts: [contract] }],
};
```

The helper infers the MIME type from the extension unless an explicit matching
`mime` is supplied. Contract descriptors have the same six fields as quotation
descriptors; DOCX uses
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
One final batch allows at most ten quotation/contract files in total, each up to
10 MB. Each contract stage explicitly includes `kind: "contract"` inside its
authenticated contents. Legacy quotation stages without `kind` remain quotations.
Neither kind may be relabeled by changing the final manifest: assembly checks
kind, sponsor, project, operation, key, expiry and every descriptor field. Reusing
a file ID across owners or attachment kinds is rejected.

The shared `document-files.mjs` validator checks genuine, bounded DOCX packages,
including ZIP directory consistency, extraction bounds, CRCs, OOXML content types,
root document relationships and the Word document. A generic ZIP, corrupted ZIP,
macro document or filename/MIME spoof does not qualify as a contract DOCX.
`contractBytes`, `assembleContractFiles` and `verifyStoredContract` additionally
verify the exact supplied length and SHA-256. Original bytes and filenames are
retained; DOCX files are downloaded rather than rendered as browser HTML.

Content deduplication is scoped to the exact sponsor and `contract` kind. A
matching quotation or another sponsor's file cannot suppress a contract upload.
Existing contract files remain unchanged. Each uploaded contract is downloaded and
verified again before its metadata is committed. Transactions guard the existing
contract metadata snapshot, full sponsor data, revision and package association,
then verify saved attachment ownership and metadata and atomically remove the
operation's staged chunks. A completed operation's private replay marker prevents
additional metadata or uploads on retry. As with quotations, no original bytes,
filenames, records or secret credentials are printed in workflow logs.

The runner matches sponsor and package names case-insensitively, rejects ambiguous
matches, and preserves contacts, payments, independent approval/PO statuses,
attachments, custom benefits and completion IDs. It enriches matching benefits
with Arabic descriptions and removes only explicitly supplied exclusions. A
provided amount changes that sponsor's agreed value, not a package's reference
price. Empty consideration text preserves existing terms. Logo imports preserve
an existing logo and validate MIME signatures and size before private storage.

SQL transactions check revisions and package snapshots before committing. A
private operation marker prevents duplicates and verifies the saved result.
Workflow logs contain aggregate counts and generic errors; decrypted records,
provider errors, SQL and private keys are not printed. A lost database response
checks the marker before cleaning staged files. Temporary plaintext/envelope
files should be removed after the authorized import is verified.

Company imports may include an optional strict `details` object with `contact`,
`mobile`, `email`, `approval`, `approvalDate`, `notesAppend` and `notesArAppend`.
Only supplied fields change; omitted contact details and approval fields retain
their existing values. Contact, mobile, email, approval and date validation use
the same rules as sponsor editing. A mobile number requires an international
country code; dates use `YYYY-MM-DD`. Explicit empty contact/mobile/email/date
values clear that field. Notes append without repeating the same text, and an
overlong combined result fails rather than discarding existing notes.

For a newly created company, supplied approval details do not issue a purchase
order or record a payment. Omitted approval details use the normal initial
defaults. Existing purchase orders, payments, attachments and benefit completion
remain unchanged. A company's `value` is its agreed sponsorship amount;
`referenceValue` changes the package's catalogue price only when explicitly
provided. Sponsor matching requires the same normalized name and does not merge
different company names based on similar spelling.

To rename an existing sponsor without changing its terms, use a strict entry
`{ name, renameTo, logo? }`. Both names are validated, and the source must resolve
to exactly one existing record. A target matching another record after Unicode
NFKC normalization, trimming and lowercasing is rejected. The same identity
cannot be reused by another entry in the batch. The transaction locks the tables
and rechecks source and target identities before changing the original record's
name, revision and Last Updated time. Its ID, package, contacts, statuses,
payments, benefits and existing attachments stay intact. An optional logo uses
the normal signature validation and preserves an already attached logo.

A retry with the same operation ID and unchanged payload uses the committed
replay marker before planning. A new operation still requires its named source;
the importer does not assume that an existing target belongs to a missing source.

For an explicitly authorized replacement of an existing sponsor's terms, a
payload entry may use `name` and `update` with `value`, the complete bilingual
`benefits` list, and `notesAppend`. It requires an existing, unambiguous sponsor;
it never creates or changes package definitions. Exact matching benefits retain
their IDs and completion flags. Other sponsor fields and attachments remain
unchanged. Notes are appended without duplicating the same text; a result beyond
the notes length limit fails rather than truncating existing information.

Use `benefitsAppend` instead of `benefits` for additional commitments that must
preserve all existing benefits. The two modes are mutually exclusive. An
explicit `approval` field may update only the approval status; purchase order
fields, approval dates and recorded payments remain independent and unchanged.
An explicit `contact` updates the contact person's name only. Existing phone and
email fields remain unchanged when no replacement details have been supplied.

To add a sponsor when only its name has been supplied, an entry may contain
`name` and `create: true`. It creates an unassigned record with an undetermined
value, empty contact/benefit/payment fields and the normal initial approval/PO
defaults. An existing case-insensitive name match is preserved unchanged rather
than duplicated or reset; ambiguous matches stop the operation. No package is
created by this mode.

The normal test suite exercises encryption, payload validation, public-key
projection and import planning with disposable fixtures. The optional
`tests/workspace-import-postgres.mjs` checks the actual application schema and
transactions using an isolated PostgreSQL container; never point it at live data.

Encrypted staging chunks may run in parallel because each uses its own workflow concurrency group and a locked, idempotent database insert. Wait for every staging run to succeed before submitting dry-run or apply. Key preparation and final imports retain the shared serialization group.
