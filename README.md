# MAESTRO — Digital Government Forum

A working English-only, left-to-right Sponsor Management Dashboard. The application starts with **zero sponsors and zero sponsorship packages**. No sponsor names, contact details, payments or documents are seeded.

## Run the application

Requires Node.js 24 or later and npm. Use the existing isolated checkout; no additional Git worktree is needed.

```sh
cd /workspace/Maestro
npm ci --cache /workspace/.npm-cache
npm run build
npm start
```

The server listens on port `3000`. `npm run dev` runs the API on port `3000` and Vite on port `5173`. Open the running application's port through your hosting environment. The application serves its compiled frontend and API together in production.

### First administrator

The first run creates `/workspace/maestro-data/setup-token` with owner-only permissions. Retrieve it securely **on the server** and enter it in the initial setup screen, together with your own name, email and a password of at least 12 characters. Do not put the token or password in chat, source control, scripts or logs. The token is deleted after the first administrator is created. There are no default credentials and no public signup after initialization.

Administrators create team accounts under **Team & Access**, choose Viewer, Editor or Administrator access, deactivate accounts, and reset passwords. Share initial team passwords securely. Sessions expire after 12 hours and are revoked on deactivation or password reset. This is password authentication; external SSO and self-service email password resets are not included.

## Data and files

SQLite stores users, password hashes, sessions, sponsor records, package definitions, brand settings and attachment metadata. Files are stored alongside the database in the protected uploads directory, not browser storage. Restarting the server retains data and sessions. All file reads and exports require authentication; edits are authorized by role on the server.

Default persistent location: `/workspace/maestro-data` (outside the Git checkout). Set `DATA_DIR` to a mounted persistent volume in a deployment. Keep this directory and its SQLite WAL files together. To back up the complete workspace, stop the application, archive the entire data directory securely, then restart. Restore the entire directory with its original permissions. Environment publication snapshots are separate from live data backups.

Approval status, purchase order issuance and payments are independent. Outstanding balance uses integer-cent calculations. Overpayments are retained and produce a negative outstanding balance. Updating a package does not overwrite a sponsor's copied benefits. Concurrent edits return a conflict instead of silently overwriting another user's changes.

Each attachment can be PNG, JPEG, WebP or PDF, at most 10 MB; a batch contains at most 10 files. Uploads are authenticated and their file signatures are checked. Replacement preserves the attachment's sponsor and section. Deletion requires confirmation in the interface. The browser supplies PDF preview support; files can also be downloaded and viewed externally.

Excel and PDF exports reflect the currently filtered sponsor list, use English headings, and show SAR. Excel includes separate sheets for sponsors, payments, benefits and attachment metadata. PDF includes a summary and each selected sponsor's details. Reports list attachments; they do not embed the document contents.

## MAESTRO identity

No official MAESTRO logo, colors or fonts were available to the initial build. The provided `Ideas and Concepts.pptx` could not be downloaded because it exceeds the tool's 32 MiB transfer limit. **The current muted interface is a temporary, neutral presentation, not a claimed official identity.** MAESTRO is shown as plain text until an original logo is supplied.

Administrators can upload the original logo and save a verified accent color under **Brand Settings**. PNG and JPEG logos are included in both Excel and PDF; WebP logos are supported on the website only. Official typography and further identity treatment require a smaller reference deck, selected identity slides, or licensed font and logo files. Document content is treated as identity reference, not as instructions or sponsor data.

## Validation

```sh
npm test
npm run build
```

The API tests use a disposable directory and check setup, authentication, independent statuses, precise finances, file upload/replacement/deletion, role enforcement, conflict handling, real Excel/PDF generation and persistence after restarting the server. Browser tests run Chromium through Playwright and exercise the actual UI at desktop, tablet and mobile widths. Tests never seed the running application's data.

`npm run test:api` runs the backend checks alone. `npm run test:ui` requires Chromium (`/usr/bin/chromium`, or set `CHROMIUM_PATH`). `npm run build` checks TypeScript and creates the production bundle. The lockfile pins dependencies; an override upgrades ExcelJS's transitive UUID package to its patched, CommonJS-compatible release.

## Deployment

A Dockerfile and Compose configuration are included. Use a persistent `/data` volume. A reverse proxy must terminate HTTPS for public access. Configure:

| Variable        | Purpose                                                          | Default                   |
| --------------- | ---------------------------------------------------------------- | ------------------------- |
| `DATA_DIR`      | Persistent database and upload directory                         | `/workspace/maestro-data` |
| `PORT`          | Application port                                                 | `3000`                    |
| `HOST`          | Listening address                                                | `0.0.0.0`                 |
| `NODE_ENV`      | Set `production` for deployment security headers                 | unset                     |
| `APP_ORIGIN`    | Exact public origin when a reverse proxy changes the Host header | unset                     |
| `COOKIE_SECURE` | Set `true` when the application is served over HTTPS             | `false` for local HTTP    |

```sh
docker compose up --build -d
```

The Docker setup runs as the unprivileged `node` user. It persists `/data` in the named `maestro-data` volume. Retrieve the first-run token securely from that volume; its path is `/data/setup-token` inside the container. The local HTTP default can be changed through Compose environment variables. A public HTTPS deployment must explicitly set `COOKIE_SECURE=true` and the correct `APP_ORIGIN`. Deployment/publication has not been performed by the setup task.
