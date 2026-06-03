# PI Transfer Tracker — Application Overview

**Last updated:** 2026-06-03
**Owner:** Pharmacy Innovations
**Repository:** abrown-PI/RxTranser-Tracker
**Production URL:** https://red-island-0bb34e510.7.azurestaticapps.net

This document inventories every service, library, and external dependency the
Transfer Tracker depends on, estimates monthly operating cost, and gives an
honest read on HIPAA posture.

---

## Architecture summary

A single-file static SPA (`index.html`) deployed as an **Azure Static Web App**.
The frontend is plain HTML/CSS/JavaScript — no framework. The "backend" is a
set of small Azure Functions colocated under `/api/` and managed by the same
Static Web App resource. State persists in Azure Table Storage and Azure Blob
Storage. Authentication is Microsoft Entra ID (formerly Azure AD) via MSAL,
plus a local-account fallback (username + scrypt-hashed PIN) for staff without
M365 licenses.

```
Browser  ─────►  Azure Static Web App  ─────►  Azure Functions (/api/*)
   │                    │                              │
   │                    │                              ├──► Azure Table Storage
   │                    │                              ├──► Azure Blob Storage
   │                    │                              ├──► Microsoft Graph (mail)
   │                    │                              ├──► Azure AI Doc Intel (OCR)
   │                    │                              └──► FedEx Track API
   │                    │
   ▼                    ▼
MSAL (Entra ID)   GitHub Actions
                  ├── deploys on push
                  ├── daily summary email cron
                  └── FedEx auto-match cron
```

---

## Azure resources

| Service | Purpose | Tier |
|---|---|---|
| **Azure Static Web App** | Hosts the SPA + manages embedded Functions runtime + custom domain + SSL | Free or Standard |
| **Azure Functions** (managed by SWA) | All `/api/*` endpoints — transfers, settings, audit, users, blobs, FedEx integration, Teams notifications, email sending, OCR proxy | Consumption (bundled) |
| **Azure Table Storage** | Persistent records — `transfers`, `audit`, `settings`, `users`, `localUsers`, `bulkDrafts`, `shipments` | Standard LRS |
| **Azure Blob Storage** | Document storage — PK transfer sheets, hard copies, CC auth forms, bulk-upload page images. Stored under the `documents` container | Hot LRS |
| **Microsoft Entra ID** (Azure AD) | Workforce sign-in via `@pharmacyinnovations.net` accounts | Free (included with M365) |
| **Microsoft Graph API** | Sends emails as `noreply@pharmacyinnovations.net` (daily summary + shipment notifications) | Free — uses M365 mailbox quota |
| **Azure AI Document Intelligence** | OCR for bulk-PDF uploads. Uses `prebuilt-read` model. Endpoint: `PIRxDocIntel` | S0 (Standard) |

### Tables in Storage

- `transfers` — every transfer record
- `audit` — append-only access log
- `settings` — global app settings (single row): Teams webhooks, admin emails, email recipient lists, pharmacy mailing addresses (with multi-day shipping schedule)
- `users` — 365-authenticated users + their assigned location + role
- `localUsers` — non-365 accounts (scrypt-hashed PIN)
- `bulkDrafts` — in-progress bulk-PDF upload queue
- `shipments` — bulk shipment records (mostly written by the FedEx auto-match cron)

### Blob containers

- `documents` — PK sheets, hard copies, CC auth forms, page images. Files stored under prefixed paths (`pages/...`, `ccauth/...`, `pksheets/...`, `hardcopies/...`)

---

## External services

| Service | Used for | Cost model |
|---|---|---|
| **FedEx Developer API** | Track API lookup by Customer Reference (transfer ID / bulk shipment ID) | Free for shippers |
| **Microsoft Power Automate / Teams Workflows** | Power Automate flows that the app POSTs to. Posts Ask Question, status delay, and anticipated-ship-date-change cards into per-location Teams chats | Included with M365 |
| **GitHub** | Source code, code review, deployments | Private repo (paid via PI's GitHub account) |
| **GitHub Actions** | CI/CD on every push to `master`. Two scheduled workflows (cron) | 2,000 min/mo free on paid plans |
| **WorldShip** (FedEx desktop) | Label generation. The Transfer ID or BULK ID goes in the Customer Reference field — the cron later resolves it to a real tracking number | Free |

---

## Frontend libraries (CDN-loaded, no install)

| Library | Used for |
|---|---|
| `@azure/msal-browser` | Microsoft sign-in (MSAL) |
| `pdf.js` | Extracting text + rasterizing PDF pages for bulk uploads |
| `JsBarcode` | Code128 barcodes on the printable packing slip |
| `html2canvas` | Capturing the fillable CC Auth form as an image for in-app attachment |

All loaded from public CDNs (cdnjs / unpkg). For a stricter compliance review,
these could be self-hosted — they don't transmit data and run entirely
client-side.

---

## Application features

### Transfers
- Single transfer entry + bulk PDF upload (auto-split via OCR)
- Refill flow that carries over docs + Rx numbers from the original
- Manual / legacy refill entry for pre-app prescriptions
- Rx History chain on the detail modal
- Inline status changes from the transfer list
- Per-row Actions: View / Edit / Receiving Rx# / Mark Paid / Ask Question
- Status dropdown including Pending Clarification + Needs Formula (Teams-notified)
- Non-transfer pickup at another pharmacy (incl. bulk pickup orders)
- Temporary patient address with through-date

### Shipments
- Create Shipment (bulk pharmacy-to-pharmacy) with BULK-* IDs + Code128 barcoded packing slip
- Per-row Incoming / Outgoing direction filter
- Date range filters
- Mark Package Received cascades Received status to every transfer in the box
- Pull from FedEx (manual) + daily auto-match cron (reference-based)

### Reports + Action Items + Alerts
- Reports tab with Summary + Detail tabs, multi-field filter bar, printable detail report, CSV export
- Action Items: Past anticipated ship date, Pending Clarification / Needs Formula, Delivered needs check-in, Canceled needs ack
- Alerts: open questions, overdue items

### Admin
- Users & Access (365 users + local accounts in one table)
- Pharmacy Mailing Addresses with multi-day shipping schedule
- Email Notifications (per-location recipient lists + always-CC)
- Teams Webhooks per location
- Document Templates preview
- Audit Log viewer with filter + CSV export

### Communications
- **Daily summary email** at 5 PM ET — per-location, sent only if that location had activity that day
- **Shipment notifications** when a shipment is created (pharmacy destination or patient destination)
- **Teams notifications** for: Ask Question, Pending Clarification / Needs Formula status, Anticipated ship date changes

### Security / HIPAA-adjacent
- **30-minute idle timeout** with 28-minute warning banner
- **Audit log** with append-only retention — records view/create/edit/delete/status_change/sign_in events
- **PHI scrubbed from console logs**
- **scrypt-hashed PINs** for local accounts
- **TLS in transit** (HTTPS only)
- **Encryption at rest** on Azure Storage (Microsoft-managed keys)
- **Role-based access** (admin / manager / tech) + location scoping for techs
- **No card data typed into the portal** — CC form is captured as image only

---

## Cost estimate

These figures assume PI's current volume (low single-digit thousands of transfers per year). Costs grow modestly with volume but stay well within the same order of magnitude for typical pharmacy operations.

| Service | Tier | Estimated monthly cost |
|---|---|---|
| Azure Static Web App | Free | **$0** (Standard is ~$9/mo if you need SLA) |
| Azure Functions | Bundled with SWA Consumption | **$0** (first 1M executions free; usage is well under) |
| Azure Table Storage | Standard LRS | **<$1** (under 1 GB, light transaction volume) |
| Azure Blob Storage | Hot LRS | **~$0.05** (a few GB of scanned docs) |
| Microsoft Entra ID | Free (included with M365) | **$0** |
| Microsoft Graph (email) | Free with M365 | **$0** |
| Azure AI Document Intelligence | S0 (prebuilt-read) | **$1-5** ($1.50 per 1,000 pages × volume) |
| FedEx Developer API | Free | **$0** |
| GitHub Actions minutes | 2,000 min/mo free | **$0** |
| Power Automate / Teams Workflows | Bundled with M365 | **$0** |
| **Total estimated** | | **~$1-15 / month** |

Excluded (already paid by PI as part of M365 / business operations):
- Microsoft 365 user licenses
- GitHub account billing
- FedEx shipping account
- Domain name + DNS

**Notable cost surprises to watch for:**
- Large surges in OCR usage (bulk PDF uploads) push the Document Intelligence
  bill up roughly linearly. A 1,000-page bulk upload day adds ~$1.50.
- Outbound bandwidth from the SWA — under the Free tier limit (100 GB/mo) for
  normal usage, but blob download volume could push past at scale.
- Sandbox vs production FedEx API — production was confirmed working; sandbox
  is free for testing.

---

## HIPAA compliance — honest assessment

**Short answer: the application is HIPAA-*friendly* but not HIPAA-*certified*.
Compliance is more than code.**

### What the technical posture already does well

- **Encryption in transit** — HTTPS enforced by Azure Static Web Apps
- **Encryption at rest** — Azure Storage encrypts all tables and blobs with Microsoft-managed keys by default
- **Authentication** — Entra ID (industry-standard OAuth/OIDC) for the primary sign-in path; scrypt-hashed PINs for local fallback accounts
- **Role-based access control** — admin / manager / tech roles + location scoping so techs see only their pharmacy's transfers
- **30-minute idle timeout** with visible warning banner
- **Audit logging** — every view, create, edit, delete, status change, and sign-in is recorded to an append-only table
- **PHI not in client console logs** — sensitive log lines were scrubbed
- **No structured card data stored** — credit card numbers exist only on scanned/captured images of the auth form
- **Hosted entirely on Azure** — Microsoft offers a Business Associate Agreement covering Azure Static Web Apps, Functions, Table Storage, Blob Storage, Entra ID, Microsoft Graph, and AI Document Intelligence under the same M365/Azure BAA umbrella

### Gaps that organizational/operational work must close

1. **Business Associate Agreements (BAAs)**
   - **Microsoft** — PI must confirm the existing M365/Azure BAA covers the specific Azure services this app uses. Microsoft offers a single BAA via the Online Services Terms; this is the most important one to verify.
   - **FedEx** — patient names + addresses are sent to FedEx for shipping. PI should confirm whether FedEx considers this PHI under their carrier BAA and what their BAA covers for the Track API.
   - **GitHub** — source code does not contain PHI, but stored issues / PRs / actions logs could leak it if anyone pastes patient data into a commit message or comment. Workforce training closes this.
   - **CDN libraries** — pdf.js, JsBarcode, html2canvas, MSAL are served from public CDNs (cdnjs / unpkg). They run client-side and don't transmit data, but a strict reviewer may require self-hosting.

2. **Formal Security Risk Assessment (SRA)**
   - HIPAA requires a documented risk assessment covering this application. Typically performed by an outside auditor or healthcare-focused security consultant. This is the single biggest item to complete before treating the app as "production-ready for PHI at scale".

3. **Policies and procedures** (organizational, not in code)
   - Workforce security policies + sanction policy
   - Breach notification procedures
   - Data retention and disposal policies
   - Workforce training records (HIPAA Security Awareness)
   - Contingency plan / incident response plan

4. **Audit and monitoring**
   - The in-app audit log is append-only from the frontend, but the underlying Azure Table is writable by anyone with the storage account connection string. For production-grade HIPAA, lock down the table at Azure RBAC layer so only specific service identities can write, and forward audit records to a long-term immutable store (Azure Log Analytics / Sentinel) for the 6-year retention HIPAA requires.

5. **Authentication strengthening**
   - MSAL token lifetime is 90 days by default. For an internal-only PHI app, conditional access policies in Entra ID can shorten this and enforce MFA. PI should review existing CA policies against the app's audience.

6. **Communication touchpoints**
   - Daily summary emails include patient names + drug names. Recipient list must be limited to authorized workforce members.
   - Teams notification cards include patient names + drugs. Membership of the per-location Teams chats must be limited the same way.
   - Both points are configurable in Admin and currently controlled by PI admins.

### Recommendation

Before treating the app as the system of record for PHI at scale:

1. Confirm in writing that PI's Microsoft BAA covers Azure Static Web Apps, Functions, Storage (Table + Blob), Entra ID, Graph, and Doc Intelligence.
2. Get a written confirmation from FedEx about whether the Track API is in-scope under their BAA, or treat the patient identifiers sent to FedEx as already-public (they're on the shipping label anyway).
3. Engage an outside reviewer for a formal Security Risk Assessment of the app. Expect to spend 2-6 weeks on this with a focused consultant.
4. Document the policies/procedures listed under "Policies" above.
5. Tighten the storage account RBAC and audit-log retention story.

After those steps, you're in position to call the system HIPAA-compliant.
Until then, it's HIPAA-friendly and appropriate for limited / supervised
use with patient data — but a formal compliance claim would be premature.

---

## Maintenance and operational notes

- **Source of truth:** GitHub repo `abrown-PI/RxTranser-Tracker`, branch `master`.
- **Auto-deploy:** every push to `master` triggers the GitHub Actions
  workflow `azure-static-web-apps-red-island-0bb34e510.yml`. Typical deploy
  time is 2-3 minutes.
- **Scheduled jobs (GitHub Actions cron):**
  - `daily-summary-email.yml` — 22:00 UTC (5 PM EST / 6 PM EDT)
  - `fedex-auto-match.yml` — 12:00 UTC (~7-8 AM ET)
- **Backups:** Azure Storage is geo-redundant by default if LRS is upgraded to GRS. Currently LRS — single-region redundancy. Worth considering GRS for production PHI ($extra cost).
- **Monitoring:** Azure Functions emit logs to Application Insights if configured. Recommend enabling for production troubleshooting.

---

## Disclaimer

This document was prepared as an internal architecture and cost reference. The
HIPAA section reflects technical readiness only and is not a substitute for a
formal Security Risk Assessment by a qualified professional. Anthropic and
Claude make no representation about the application's HIPAA compliance status.
PI is responsible for verifying BAA coverage with each subprocessor and for
maintaining the organizational policies required by HIPAA.
