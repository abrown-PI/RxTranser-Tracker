# PI Transfer Tracker — Quick Reference Guide

## Overview

The PI Transfer Tracker is Pharmacy Innovations' tool for managing inter-pharmacy prescription transfers. It tracks prescriptions from the originating pharmacy location through sterile compounding at Erie and back to the origin or directly to the patient.

---

## Getting Started

### Logging In
- In the current demo version, use the **user switcher** dropdown in the top-right of the navbar to switch between users.
- In production, authentication will be handled via Azure AD / MSAL.

### User Roles

| Role | Access |
|------|--------|
| **Admin** | Full access to all locations, all tabs including Admin. Can manage users, SLA rules, and formula library. |
| **Manager** | Full read access across locations plus Reports. |
| **Tech** | Sees only transfers and shipments involving their own location (as origin or fill). |

---

## Navigation Tabs

### 1. Transfers
The main view showing all transfer requests visible to your role/location.

**Filters available:**
- Search by patient name, Rx number, or tracking number
- Filter by status, origin location, or fill location

**Transfer Statuses:**
| Status | Meaning |
|--------|---------|
| **New** | Just submitted, not yet picked up by the fill location |
| **Tx Verified** | Transfer paperwork has been verified against the hard copy |
| **In Progress** | Actively being compounded at the fill location |
| **Ready to Ship** | Compounding complete, awaiting shipment |
| **Shipped** | Package is in transit |
| **Delivered** | Patient or pharmacy has received the order |
| **Canceled** | Transfer was canceled |

**Clicking a transfer** opens its detail modal where you can:
- Update the status
- View/edit shipping and tracking info
- Review attached documents (PK Sheet, Formula, Hard Copy)
- Verify prescriptions against hard copies (checkbox per item)
- Post comments (scoped to the whole transfer or a specific Rx)

---

### 2. + New Transfer
Submit a new transfer request. Required fields are marked with a red asterisk.

**Required:**
- Patient Name
- At least one prescription with a drug name
- PK Transfer Sheet (upload PDF/image)
- Formula Worksheet (select from location library OR upload new)

**Key sections:**
- **Patient** — Name, DOB, allergies
- **Routing** — Origin location (your pharmacy) and fill location (typically Erie for sterile compounds)
- **Shipping** — Ship to Pharmacy, Patient, or Delivery; address fields; cold item checkbox
- **Billing** — HealNow, Credit Card, or Pay In Store; Sema Dr Authorization status
- **Documents** — PK Transfer Sheet, Formula (from library or upload), optional Hard Copy scan
- **Items/Prescriptions** — Drug, quantity, Rx number, doctor info, receipt attached, notes. Add multiple Rx lines with "+ Add another Rx"

**Formula Library:** When creating a transfer, you can pick a saved formula from your location's library instead of uploading. If you upload a new formula, check "Save to my location's library for reuse" to add it for future use.

---

### 3. Pharmacist Review
Shows transfers that have **unverified items** — prescriptions where the PK transfer form has not yet been confirmed against the hard copy. A badge on the tab shows the count.

- Admins see all unverified items
- Fill-location techs see items they need to verify
- Check the "PK form matches hard copy" box on each item once verified

---

### 4. Shipments
Manage physical shipments between locations.

**Features:**
- **Barcode scanner input** — Focus the scan field and scan a tracking barcode to jump directly to that shipment
- **Create Shipment** — Bundle one or more transfers into a shipment with carrier/tracking info
- **Receive Shipment** — When a shipment arrives at your location, click "Receive" to:
  - Confirm arrival
  - Unpack and verify each item
  - Report any damage (with photo upload)
- Filter by your location or search by tracking number

**Shipment Statuses:**
| Status | Meaning |
|--------|---------|
| **Pending** | Shipment created but not yet sent |
| **In Transit** | Shipped and on its way |
| **Delivered** | Carrier confirms delivery |
| **Received** | Staff at the destination has physically received and unpacked |

---

### 5. SLA Alerts
Flags transfers that are approaching or have exceeded their time limits.

**Default SLA Rules:**
| Status | Time Limit |
|--------|-----------|
| New | 24 hours |
| Tx Verified | 48 hours |
| In Progress | 72 hours |
| Ready to Ship | 24 hours |

- **Breach** (red) — Transfer has exceeded the allowed time in its current status
- **Near SLA** (yellow) — Transfer is at 75%+ of the allowed time
- SLA rules can be adjusted by admins in the Admin tab
- In production, breaches will auto-notify assigned users via Teams

---

### 6. Reports
Dashboard with KPIs and analytics.

**KPI Cards:**
- Total Transfers (scoped to your visibility)
- In Flight (not yet delivered)
- Avg Cycle Time (Tx email to ship date)
- Avg Turnaround (Tx email to delivered)
- On-Time Ship Rate
- SLA Breaches
- Cold Chain Items

**Report Tables:**
- Volume by Status
- Avg Turnaround by Origin Location
- Volume by Origin Location
- Unverified Items list

**Export:** Click "Export CSV" to download all visible transfer data.

---

### 7. Admin (Admin role only)

**Users & Roles**
- Add or remove users
- Change a user's location or role (admin / manager / tech)

**SLA Rules**
- Adjust the hour limits for each status threshold
- Click "Save SLA rules" to apply

**Formula Library**
- Add, edit, or remove reusable formula worksheets
- Each formula is scoped to a specific location
- Formulas can include a SharePoint link for the source document

**Teams Webhooks**
- Configure Microsoft Teams webhook URLs per location for automated notifications (planned for production)

---

## Global Search
The search bar in the top navbar searches across **all visible transfers and shipments** by:
- Patient name
- Rx number
- Tracking number
- Doctor name
- Location
- Drug name

Click a result to jump directly to that transfer or shipment.

---

## Key Workflows

### Submitting a Transfer (Origin Pharmacy Tech)
1. Go to **+ New Transfer**
2. Fill in patient info, routing, shipping, and billing
3. Upload the PK Transfer Sheet
4. Select or upload a Formula Worksheet
5. Add prescription line items with doctor details
6. Click **Submit transfer**

### Processing a Transfer (Fill Location / Erie)
1. Check the **Transfers** tab for new incoming transfers
2. Open the transfer and review documents and items
3. Verify each item against the hard copy (check the box)
4. Update status: New → Tx Verified → In Progress → Ready to Ship
5. Create a shipment when ready

### Receiving a Shipment (Destination Pharmacy Tech)
1. Go to **Shipments** tab
2. Scan the tracking barcode or find the shipment in the list
3. Click **Receive**
4. Verify each item and report any damage
5. Shipment moves to "Received" status

---

## Tips
- **Cold items** are flagged with a blue "Cold" badge — these require special packaging and handling
- **Color-coded rows** in the Transfers table indicate SLA status (red = breach, yellow = near SLA)
- **Comments** can be scoped to a specific Rx item or the whole transfer — use the dropdown before posting
- The **"Notify via Teams"** checkbox on comments will send a Teams notification in production
- **Unverified items** show a yellow warning pill in the Transfers table and appear in Pharmacist Review

---

## Locations

Erie | Lancaster | Greenville | Spring | Tucson | Flower Mound | Denton | Corinth | Jamestown | Virginia Beach | Seminole

---

*PI Transfer Tracker — Pharmacy Innovations*
