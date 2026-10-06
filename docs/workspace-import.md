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
   bytes must be verified originals, not generated artwork. Split large images
   into separate imports; the full envelope limit still applies.

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

The normal test suite exercises encryption, payload validation, public-key
projection and import planning with disposable fixtures. The optional
`tests/workspace-import-postgres.mjs` checks the actual application schema and
transactions using an isolated PostgreSQL container; never point it at live data.
