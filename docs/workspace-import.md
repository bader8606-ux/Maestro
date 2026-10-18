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
   imports must still fit the full envelope limit. Original PDF quotations use
   the protected chunk staging procedure below when they exceed that limit.

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
