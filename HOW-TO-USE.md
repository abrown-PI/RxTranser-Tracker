# PI Transfer Tracker — How to Use

A quick guide for daily tasks. Bookmark this page or print it.

**Website:** https://red-island-0bb34e510.7.azurestaticapps.net

---

## Signing In

1. Open the site
2. Click **🔐 Sign in with Microsoft** in the top right
3. Sign in with your **@pharmacyinnovations.net** account (same one you use for Outlook/Teams)
4. First time only: pick your location from the dropdown in the top right. The app remembers it next time.

If you ever need to switch which pharmacy you're working from for the day, just change the dropdown in the navbar.

---

## Creating a New Transfer

There are two ways:

### Single Transfer
Use this when you have one transfer to enter.

1. Click **+ New Transfer**
2. Fill in the form:
   - **Patient Name** is required
   - At least one **PK Transfer Sheet** upload is required
   - If billing is **Credit Card** and the card is NOT on file: upload the signed CC Authorization Form (see "Credit Card Workflow" below)
3. Click **Submit transfer**

> **Tip:** If you upload a clean PDF transfer sheet, the app auto-fills patient name, DOB, drug, and Rx# from the sheet. You only need to verify/edit.

### Bulk Upload (multiple transfers at once)
Use this when you have a stack of transfers in one PDF.

1. Click **+ New Transfer** → toggle to **Bulk Upload** at the top right
2. Click **📁 Select PDFs to upload** and pick the file(s)
3. The app splits each PDF: every "PATIENT Rx TRANSFER INFORMATION" page becomes its own draft. Hard copies/order forms that follow get attached to that draft.
4. Review the queue — drafts marked **⚠ Needs Review** are missing required fields
5. Click **Edit** to fix any flagged drafts
6. Click **Approve** on each ready draft, OR click **Approve all N ready** at the top to do them in one shot

---

## Refilling an Existing Transfer

1. Click **+ Refill** (top tab)
2. Search by patient name, Origin Rx#, or Receiving Rx#
3. Click **Refill this →** on the right transfer
4. Review the **Shipping & Payment Defaults** (auto-pulled from the original). Click **Edit** if anything changed.
5. Check the **Prescriptions** boxes for which Rx to include in this refill
6. Click **Continue to refill form →**
7. The form is pre-filled — review, attach a fresh PK transfer sheet, hit **Submit**

> Refills don't require a hard copy scan — it's optional.

---

## Editing a Transfer After Submission

1. From the Transfers tab, click the row to open the detail modal
2. Click **✏️ Edit Transfer** at the top
3. Change anything: patient info, routing, ship-to, billing, documents
4. Click **Save changes**

> Use this to fix typos, update the ship-to address, swap the wrong origin pharmacy, or add documents that came in later.

---

## Asking a Question About a Transfer

Use this when you need info from another pharmacy.

1. From the Transfers list, find the patient → click **❓ Ask question** on that row
   *(Or open the transfer and click ❓ Ask Question at the top.)*
2. Type your question, click **Send Question**
3. The other location gets a Teams notification with a button to open the transfer
4. They reply in the transfer's **Discussion** section
5. Your reply appears for them on their **Alerts** tab

You can see questions YOU asked that are still unanswered on the **Alerts** tab → "Questions You've Asked" section.

---

## Checking Alerts

The **Alerts** tab shows three things:

1. **Open Questions** — questions other team members asked YOUR location, waiting for your answer. Click **Answer →** to open the transfer.
2. **Questions You've Asked** — your own pending questions still waiting on a reply.
3. **Transfers Past Status Time Limit** — transfers stuck in one status too long. Click any row to open and update.

The number in the **Alerts** tab badge = open questions for you + overdue transfers.

---

## Credit Card Workflow

When billing = **Credit Card** AND the card is NOT on file:

1. On the New Transfer form, click **🖨 Print blank CC Auth Form**
2. A one-page PDF prints with patient name + drug pre-filled. The patient signs it.
3. Scan the signed form
4. Upload it in the **Signed Credit Card Authorization Form** field on the same transfer
5. Billing team opens the transfer in the app → clicks **View / Print Signed Form** when they need to charge

> Card info goes on the paper form — never typed into the app — for compliance.

---

## Shipments

### Creating a Bulk Pharmacy Shipment (weekly box to another pharmacy)
1. **Shipments** tab → **+ Create Shipment**
2. Destination Type: **Pharmacy**, To: pick the destination pharmacy
3. The list below auto-loads open transfers going to that pharmacy. Check the ones in this box.
4. Carrier: FedEx (or whichever), tracking #: paste from FedEx Ship Manager
5. **Create Shipment**
6. App offers to print a **packing slip** with the bulk shipment ID + Code128 barcode + manifest. Put this inside the box.

### Receiving a Shipment
1. **Shipments** tab → focus the **📷 Scan tracking barcode** field at the top
2. Scan the FedEx barcode OR the bulk packing slip barcode
3. The shipment opens — click **📦 Arrived at my pharmacy** when the box is in your hand
4. Check off each Rx as you unpack it
5. Take photos of any damage with the camera button
6. Click **Mark Package Received**

---

## Printing & Batch Operations

### Batch print transfer sheets (Erie sterile team)
1. **Transfers** tab → check the boxes next to transfers you want to print
2. Click **🖨 Print Selected (N)** at the top right
3. App opens a print window with all selected PK sheets + hard copies in one job
4. After printing, the app auto-changes those transfers to **In Progress**

---

## Pulling Tracking from FedEx

When the FedEx integration is set up:
1. **Shipments** tab → click **📦 Pull from FedEx**
2. Pick a date range (default last 10 days)
3. App pulls all shipments from your FedEx account in that range
4. App auto-matches each FedEx shipment to an open transfer by ship-to address
5. Review matches — high-confidence ones are pre-checked. Uncheck or change as needed.
6. Click **Apply** — tracking numbers + dates get linked

Status updates automatically every 15 min while someone has the Shipments tab open.

---

## Admin Tasks (admins only)

The **Admin** tab is only visible if your email is in the Admin Users list.

- **Admin Users**: type emails, click + Add, then Save
- **SLA Rules**: how long a transfer can sit in each status before it shows on the Alerts tab
- **Formula Library**: saved formula worksheets per pharmacy
- **Pharmacy Mailing Addresses**: used for Ship-to-Pharmacy auto-fill
- **Teams Webhooks**: paste Power Automate webhook URLs per location (see separate Teams setup guide)

---

## Status Definitions

| Status | What it means |
|---|---|
| **New** | Just submitted, not yet processed |
| **In Progress** | Being compounded at the fill location |
| **Ready to Ship** | Compounding done, awaiting shipment |
| **Shipped** | In transit |
| **Delivered** | Patient or pharmacy has received |
| **Canceled** | Transfer canceled (must be acknowledged on Alerts tab before being archived) |

---

## Common Questions

**Q: I picked the wrong origin pharmacy and submitted. Can I fix it?**
A: Yes — open the transfer → ✏️ Edit Transfer → change origin → Save.

**Q: A patient changed their address. How do I update for refills?**
A: Edit the existing transfer with the new address before refilling, OR start the refill and use the **Edit** button on the Shipping & Payment Defaults to override.

**Q: We canceled a transfer — does the app know?**
A: Change the status to **Canceled** on the transfer. It will show up under Action Items until someone acknowledges it. This prevents accidentally shipping it.

**Q: How do I see all transfers for one patient?**
A: Use the search bar at the top of the navbar — type their name. Results include their transfers AND shipments.

**Q: Can I export the list?**
A: Yes — **Reports** tab → **Export CSV** at the bottom.

---

*Need to update this guide? It lives in the repo at `HOW-TO-USE.md`.*
