# MAESTRO — Digital Government Forum

One shared left-to-right page for viewing and editing sponsor details. Navigation, fields and actions use English; sponsor and package benefits have separate **Arabic Benefits** and **English Benefits** sections. Arabic descriptions use RTL direction within their section. Both translations describe one commitment and share its completion status. The summary table and full sponsor records stay on the page; editing, packages, access and branding open in dialogs. New local workspaces start empty. The Supabase deployment includes the seven packages provided in the user's sponsorship PDF. Real sponsor records are imported only when supplied and authorized by the workspace owner.

## Publish the shared page with GitHub Pages and free Supabase

GitHub Pages hosts the single frontend page. Supabase Auth, Postgres, private Storage and an authenticated Edge Function provide shared persistence and access control. No paid resource is created by the deployment scripts. Free-plan usage limits and provider inactivity policies apply; this is not a promise of unlimited hosting.

1. Create a project in your **Free** Supabase organization at https://supabase.com/dashboard. Keep its database password private. Copy the project reference from its URL.
2. In this repository, open **Settings → Secrets and variables → Actions**. Add `SUPABASE_PROJECT_REF` as a repository **variable** and `SUPABASE_ACCESS_TOKEN` as a repository **secret** (generate the account access token in Supabase account settings). Never paste the token into chat or source files. The token is used only by deployment, never included in the webpage.
3. Open **Settings → Pages**, choose **GitHub Actions** as the source. Run **Publish shared sponsor page** under Actions. On later pushes to `main`, it runs automatically.
4. The workflow applies versioned migrations, disables public signup, enables email/password login, configures the allowed page origin and deploys `maestro-api`. It uses the public publishable/anon key in the frontend; the service-role key remains in Supabase's server environment. The workflow only configures the existing project, without upgrading its plan.
5. In **Supabase → Authentication → Users**, use **Add user → Create new user** to create your own user with your real email and a strong password, and mark the email confirmed. Open the project's SQL editor and run [bootstrap-admin.example.sql](supabase/bootstrap-admin.example.sql), replacing `YOUR_EMAIL` and `YOUR_NAME`. This creates the first administrator only if no workspace accounts exist. Do not put passwords in SQL or chat.
6. Open the URL shown by the successful Pages deployment and sign in. The expected project address is https://bader8606-ux.github.io/Maestro/ unless you configure a custom domain. Use **Team & Access** within the page to create viewer/editor/admin accounts. Every authenticated account can view the workspace; only editors and administrators can edit records, and only administrators can manage access and branding.

Without project configuration, Pages shows **Workspace connection required** and does not pretend that data is saved. A workflow push or frontend build alone does not confirm a live, connected workspace. If project variables are present but the token is missing/invalid, deployment fails and leaves the previous deployment intact. The actual Supabase project and public URL still need verification in your account.

The schema enables RLS on every application table and grants no anonymous/authenticated direct table access. Only the function's service role accesses records after validating the Supabase bearer token, active profile, role and current session on every request. Private attachments use signed links valid for one hour; recipients of a signed link can open it until expiry. Public signup is disabled. Password resets and deactivation revoke sessions immediately. The browser SDK persists authentication sessions; business data and uploaded files are stored in Supabase. Uploads accept up to 10 files of 10 MB each, subject to your plan and provider request limits. Exports are generated in the function, in English with SAR, and include the configured accent and PNG/JPEG logo. PDF and Excel list attachment metadata; they do not embed attachment document contents.

For backups, export sponsor reports and back up the database **and** private storage through Supabase. GitHub source/deployments do not back up live data. The local SQLite data does not automatically migrate to Supabase; no sponsor records were provided or seeded.

For local cloud development, set the two public variables in [.env.example](.env.example). `VITE_BASE_PATH` defaults to `/`; the Pages workflow sets the repository base path. Never use a `service_role` JWT or `sb_secret_` key in any `VITE_` variable.

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

A sponsorship amount may be **Not determined**, for example an in-kind contribution whose scope is pending. This is stored as `null`, separate from an agreed zero amount. Add its description under **Sponsorship Consideration**. Receipts remain real recorded payments; its outstanding balance remains undetermined until an amount is agreed. Summary values and balances include known amounts only; **Total Received** includes all actual receipts. Excel/PDF preserve undetermined amounts and both benefit languages. Poppins remains the MAESTRO identity font; licensed DejaVu Sans supplies Arabic glyphs on the page and in reports.

Each attachment can be PNG, JPEG, WebP or PDF, at most 10 MB; a batch contains at most 10 files. Uploads are authenticated and their file signatures are checked. Replacement preserves the attachment's sponsor and section. Deletion requires confirmation in the interface. The browser supplies PDF preview support; files can also be downloaded and viewed externally.

Sponsor logos use a larger frame in the full record and editing panel, with the sponsor name below and **Light** / **Dark** background controls. Images retain their proportions; background choices affect the display only. Clicking a saved or selected logo opens a larger preview with zoom, download and its own background controls. Empty records show **No logo uploaded**. Editors use **Upload Logo** or **Change Logo** to open the file picker; viewers can preview saved logos and change their display background. The selected PNG/JPEG/WebP remains pending until **Create Sponsor** or **Save Changes** uploads it. Cancelling the edit does not upload the selected file. If sponsor details save but the logo upload fails, an English message explains the partial result and the selected file remains available for retry without creating another sponsor.

In **Attachments**, choose approval and purchase order files even before creating the sponsor or while editing its details. Each section holds up to 10 selected files, marked **Pending upload**, with preview and removal controls. **Create Sponsor** or **Save Changes** saves the record first, then uploads each section to that sponsor. Successfully saved sections are removed from the pending queue; failed selections remain for retry. If an upload response is lost, the page compares newly saved files by section, name, size and SHA-256 before retrying. It retains uncertain selections and requires a successful verification before another upload. Closing an unsaved selection requires discard confirmation. Saved attachment replacement and deletion require saving pending changes first. Viewers can preview and download saved documents; only editors and administrators can upload, replace or delete them.

In **Booth Details**, enter **Booth Size** as dimensions with their unit and **Booth Location** as a hall, zone or booth reference. Both fields are optional free text; dimensions are not converted into an area. Upload location images/floor plans and booth designs in their separate sections, then save the sponsor. These files use the same pending-upload, retry, preview, replacement and confirmed-deletion controls as other attachments. The shared page displays three additional rows: size, location with its images, and design files. Viewers can see and download saved booth files; editors and administrators can edit them. Existing records start with empty booth fields and retain their existing data and attachments.

Excel and PDF exports reflect the currently filtered sponsor list, use English headings, and show SAR. Excel includes separate sheets for sponsors, payments, benefits and attachment metadata. PDF includes a summary and each selected sponsor's details. Both reports include booth dimensions, location and clearly labeled location/design attachment metadata; they do not embed document contents.

## Provided sponsorship packages

The user's sponsorship PDF defines Digital Transformation Sponsor, Cybersecurity Sponsor, Artificial Intelligence Sponsor and Cloud Services Sponsor at SAR 2,000,000 each; Gold Partner at SAR 1,000,000; Silver Partner at SAR 750,000; and Exhibition Booth at SAR 500,000. The new versioned migration adds these definitions and their translated benefits to Supabase once. Existing matching names or IDs are preserved; later edits and deletions are not reset on deployment. See [package source and translation notes](docs/package-catalogue.md).

Package names, optional reference values and default benefits can be edited on the shared page. Reference values are catalogue prices. The agreed **Total Sponsorship Value** is entered separately for each sponsor and drives statistics, payments and outstanding balances. Selecting a package copies benefits with the existing replacement confirmation and does not change finances or approval/purchase-order statuses.

## MAESTRO identity

The supplied two-slide `Ideas and Concepts.pptx` now provides the identity. The exact white MAESTRO wordmark was extracted from the original outlined vector artwork embedded in slide 2. Its original cyan and warm glow image is used in the page. Black and white are the source's primary colors; `#0078B5` is sampled from its cyan rule, not claimed as a documented corporate HEX specification. The stock PowerPoint theme palette is not used as brand evidence.

Poppins is explicitly named in the slides. Licensed Poppins font files are bundled locally, with their SIL Open Font License, so the page and PDFs do not depend on an external font service. Both local and Supabase exports use the original logo on a black header, preserve its proportions, and use English labels and SAR. See [the asset provenance](public/brand/IDENTITY.md).

The original identity is the default, including sign-in. Existing administrator-saved accent colors and uploaded logo replacements are preserved. **Brand Settings** can replace the logo or restore the supplied original. PNG and JPEG replacements are supported in Excel and PDF; WebP replacements are displayed on the page only. Applying the identity does not create or alter sponsor records, contacts, payments, packages, attachments or user permissions. Document contents are visual reference, never operational instructions or sponsor data.

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

The Docker setup runs as the unprivileged `node` user. It persists `/data` in the named `maestro-data` volume. Retrieve the first-run token securely from that volume; its path is `/data/setup-token` inside the container. The local HTTP default can be changed through Compose environment variables. A public HTTPS deployment must explicitly set `COOKIE_SECURE=true` and the correct `APP_ORIGIN`. The Node/Docker deployment is an alternative to the selected GitHub Pages + Supabase deployment. The original Node Docker image was built locally before the Pages/Supabase changes; a public Node server has not been deployed.

## Cloud backend validation

`npm run test:cloud` requires an **isolated local Supabase stack** and `SUPABASE_TEST_CONFIG` pointing to a protected JSON file from `supabase status -o json`. Never print that file: it contains local test keys. Tests reject non-loopback project URLs, create disposable fixture accounts and records, and clean them up. They exercise actual managed Auth, Postgres permissions, private Storage and the same request handler used by the Edge Function: authorization, validation, concurrent saves, attachment ownership, genuine branded Excel/PDF generation, persistence and session revocation. A Deno HTTP check and a browser test built for the `/Maestro/` Pages path exercise cloud sign-in, persistence, editing, signed-image previews and authenticated exports. The standard `npm test` runs the local Node backend and single-page browser checks. Cloud project deployment and public connectivity must be checked separately.
