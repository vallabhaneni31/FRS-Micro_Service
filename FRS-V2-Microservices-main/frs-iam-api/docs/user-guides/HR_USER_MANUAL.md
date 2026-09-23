# HR User Manual — Motivity Face Recognition System
**Audience:** HR Managers & HR Personnel  
**Version:** July 2026

---

## Table of Contents

**GETTING STARTED**
1. [Logging In — Workspace + Credentials](#1-logging-in)
2. [First-Time Password Setup (Invite Flow)](#2-first-time-password-setup)
3. [Navigating the Application (Sidebar)](#3-navigating-the-application)

**ONE-TIME SETUP (must do in order)**
4. [Step 1 — Create Departments](#4-step-1--create-departments)
5. [Step 2 — Create Shifts](#5-step-2--create-shifts)
6. [Step 3 — Add Employees](#6-step-3--add-employees)
7. [Step 4 — Bulk Import Employees via CSV](#7-step-4--bulk-import-employees-via-csv)
8. [Step 5 — Face Enrollment](#8-step-5--face-enrollment)
9. [Step 6 — Track Enrollment Status (Remote Enrollment Manager)](#9-step-6--track-enrollment-status)

**DAILY OPERATIONS**
10. [HR Overview Dashboard](#10-hr-overview-dashboard)
11. [Daily Attendance — Roster View](#11-daily-attendance--roster-view)
12. [Punch Details Modal (Per-Employee Day View)](#12-punch-details-modal)
13. [Live Office Intelligence (Who Is In Right Now)](#13-live-office-intelligence)
14. [Presence Monitor](#14-presence-monitor)

**RECORDS & HISTORY**
15. [Monthly Attendance Grid](#15-monthly-attendance-grid)
16. [Attendance Calendar](#16-attendance-calendar)
17. [Employee Profile](#17-employee-profile)
18. [Employee Timesheet Drawer](#18-employee-timesheet-drawer)

**ANALYTICS**
19. [Attendance Analytics](#19-attendance-analytics)
20. [Multi-Employee Analysis](#20-multi-employee-analysis)
21. [Departments & Shifts Analytics (Roster Tab)](#21-departments--shifts-analytics)

**EXPORTS & REQUESTS**
22. [Exporting Attendance Data](#22-exporting-attendance-data)
23. [Regularization (Attendance Correction) Requests](#23-regularization-requests)
24. [Enrollment History Log](#24-enrollment-history-log)

**REFERENCE**
25. [Quick Reference — All Field Definitions](#25-quick-reference--all-field-definitions)
26. [Status Colour Legend](#26-status-colour-legend)

---

## 1. Logging In

**URL:** Your company's application URL (e.g. `https://yourcompany.motivity.ai`)

### Phase 1 — Enter Your Workspace Name
When you open the app for the first time (or on a shared/apex domain), you will see a single field:

| Field | What to enter |
|-------|---------------|
| **Workspace** | The slug your administrator gave you (e.g. `motivity-demo`, `abc-corp`) |

Click **Continue**. The system validates the workspace. If it says "does not exist", check the spelling with your admin.

> **Tip:** If you access the app via your company's dedicated subdomain (e.g. `acme.motivity.ai`), the workspace step is skipped automatically — you go straight to credentials.

### Phase 2 — Enter Your Credentials

| Field | What to enter |
|-------|---------------|
| **Email** | Your work email address (e.g. `hr@company.com`) |
| **Password** | Your account password |

Click **Sign In**.

- If MFA is enabled, you will be prompted for a **one-time code** from your authenticator app.
- On success you land on the **HR Overview Dashboard**.
- If you need to change the workspace, click the **← back** link above the email field.

---

## 2. First-Time Password Setup

When your administrator creates your account, you receive an **invitation email** with a link.

**Steps:**
1. Click the link in the email — it opens the **Setup Password** page.
2. The page greets you: `👋 Hi [Your Name], you've been invited to [Workspace Name].`
3. Enter your new password (follow the strength requirements shown).
4. Confirm the password.
5. Click **Set Password**.
6. You are redirected to the login page — sign in with your email and new password.

---

## 3. Navigating the Application

**Sidebar (left panel)** — visible on every screen. Items visible depend on your HR role.

| Sidebar Item | What it opens |
|---|---|
| **HR Overview** | Live dashboard — today's attendance snapshot |
| **Attendance** | Daily roster, monthly grid, calendar, analytics |
| **People / Employees** | Add, edit, manage employees + face enrollment |
| **Departments & Shifts** | Create/manage departments, shifts, and assign employees |
| **Presence Monitor** | Live feed of who is currently inside the building |
| **Live Office Intelligence** | Real-time occupancy table with search and filters |
| **Enrollment** | Remote enrollment manager + enrollment history |
| **Analytics** | Charts, trends, multi-employee comparisons |
| **Configurations / HRMS** | HRMS integration settings |

The **workspace name** and your **portal label** (e.g. "HR Portal") appear at the top of the sidebar.

Click the **collapse/expand** icon (arrow) at the top of the sidebar to minimise it to icon-only mode.

---

# ONE-TIME SETUP

> Complete Sections 4 → 8 in order before any attendance data will be captured correctly.

---

## 4. Step 1 — Create Departments

**Why first:** Employees cannot be created without a Department selected.

**Where to go:** Sidebar → **Departments & Shifts** → `Departments` tab

### Stats bar (top of page)
| Tile | Shows |
|------|-------|
| Total Employees | All active staff |
| Present Today | Checked in so far |
| Late Arrivals | Past grace period |
| Absent Today | No check-in recorded |

### Create a Department
1. Click **+ Add Department** (top-right).
2. A modal opens. Fill in:

| Field | Required | What to enter | Example |
|-------|----------|---------------|---------|
| **Name** | ✅ | Full department name | `Data Engineering` |
| **Code** | ✅ | Short abbreviation (appears in exports) | `DE` |
| **Colour** | ✅ | Pick from the colour palette | Blue |
| **Description** | ➖ | Optional notes | `Backend & pipeline teams` |

3. Click **Save**.

### Assign Employees to a Department
> Do this after employees are created (Section 6).

1. Find the department row and click the **Assign** icon (people silhouette).
2. An **Assign Employees** modal opens — shows all employees with checkboxes.
3. Tick the employees who belong to this department.
4. Click **Assign N employees**.

### Edit a Department
Click the **pencil icon** → change any field → **Save**.

### Delete a Department
Click the **trash icon** → confirm. If employees are assigned, a second prompt asks to **Force Delete** (employees become unassigned).

---

## 5. Step 2 — Create Shifts

**Why second:** Employees cannot be created without a Shift selected.

**Where to go:** Sidebar → **Departments & Shifts** → `Shifts` tab

### Create a Shift
1. Click **+ Add Shift**.
2. Fill in the modal:

| Field | Required | What to enter | Example |
|-------|----------|---------------|---------|
| **Shift Name** | ✅ | Descriptive name | `Morning Shift` |
| **Shift Type** | ✅ | Select: `morning` / `afternoon` / `night` / `flexible` | `morning` |
| **Start Time** | ✅ (if not Flexible) | 24-hour format | `09:00` |
| **End Time** | ✅ (if not Flexible) | 24-hour format | `18:00` |
| **Grace Period (min)** | ✅ | Minutes after start before status becomes "Late" | `10` |
| **Flexible** | ➖ | Toggle ON → no fixed start time, employees never marked Late | Off |
| **Work Days** | ✅ | Click each day to toggle on (highlighted) / off | Mon Tue Wed Thu Fri |

3. Click **Save**.

> **Flexible shifts:** When toggled ON, the Start Time and End Time fields disappear. Employees on this shift are always marked Present (never Late) regardless of when they arrive.

### Assign Employees to a Shift
Same as department assignment — click the **Assign** icon on the shift row and select employees.

### Edit / Delete a Shift
- Edit: pencil icon → change fields → Save.
- Delete: trash icon → confirm ("Employees will be unassigned").

---

## 6. Step 3 — Add Employees

**Where to go:** Sidebar → **People / Employees**

### Top Stats bar
| Tile | Shows |
|------|-------|
| Headcount | Total employees (active count shown in hint) |
| Enrolled | % who have face data — `X of Y` |
| Consent | % who have granted biometric consent |
| Departments | Number of departments · shifts |
| Needs attention | Employees with incomplete records (no dept, no shift, no enrollment) |

### Add a Single Employee
1. Click **+ Add Employee** (top-right button).
2. A **slide-in panel** opens on the right with a **live preview card** at the top — it updates as you type.
3. Fill in all fields:

| Field | Required | What to enter | Example |
|-------|----------|---------------|---------|
| **Full Name** | ✅ | Employee's legal full name | `Priya Sharma` |
| **Employee Code** | ✅ | Unique alphanumeric ID (must not repeat) | `MLII90` |
| **Email** | ✅ | Valid work email address | `priya@company.com` |
| **Phone Number** | ➖ | Mobile number | `9876543210` |
| **Position / Title** | ➖ | Job designation | `Software Engineer` |
| **Location** | ➖ | Office location label | `Madhapur` |
| **Department** | ✅ | Select from dropdown (must exist — create in Step 1) | `Data Engineering` |
| **Shift** | ✅ | Select from dropdown (must exist — create in Step 2) | `Morning Shift` |
| **Join Date** | ✅ | Date of joining (auto-fills today's date) | `2026-07-01` |
| **Site(s)** | ➖ | Tick one or more site checkboxes if multi-site org | `Hyderabad HQ` |

4. The preview card at the top shows the initials avatar, name, title, department, shift, and code in real time.
5. Click **Create Employee**.
6. A **success screen** appears showing the new employee card. You can immediately click **Enroll Face** from here to proceed to Step 5.

> **Validation:** The **Create** button stays disabled until Full Name, Employee Code, a valid Email, Department, and Shift are all filled. An invalid email shows a red error: "Enter a valid email address."

### Edit an Employee
1. Find the employee (search or filter).
2. Click the employee **row** or the **edit (pencil) icon** in the actions column.
3. The same slide-in panel opens pre-filled.
4. Change any field and click **Save Changes**.

### Deactivate / Reactivate an Employee
- In the employee row, click the **status toggle** (Active ↔ Inactive).
- Inactive employees no longer appear in live attendance views.

### Quick Filters (left rail of People page)
| Filter chip | Shows |
|------------|-------|
| **Unenrolled** | Employees with zero face angles on file |
| **Consent pending** | Have not granted biometric consent |
| **Inactive** | Deactivated accounts |
| **Low-quality** | Enrolled but with poor recognition scores |
| **New this month** | Joined in the current calendar month |
| **Needs attention** | Missing dept, shift, or enrollment |

### Sort Options (top of list)
Name · Employee Code · Department · Status · Enrollment · Consent · Recently Joined

### Bulk Actions
Select multiple employees using the **checkboxes** on the left, then use the bulk action bar:
- **Assign Department** → dropdown to select dept → applies to all selected
- **Assign Shift** → dropdown to select shift → applies to all selected
- **Send Enrollment Invite** → sends enrollment email to all selected

---

## 7. Step 4 — Bulk Import Employees via CSV

**When to use:** You have 10+ employees to onboard at once.

**Where to go:** Sidebar → **People / Employees** → **Import** button (top-right)

### Steps
1. Click **Download Template** to get the correct CSV format (with site IDs shown on screen).
2. Fill in the spreadsheet — one employee per row:

| Column | Required | Notes |
|--------|----------|-------|
| `employee_code` | ✅ | Unique per employee. If code already exists, that record is **updated** (not duplicated). |
| `first_name` | ✅ | |
| `last_name` | ✅ | |
| `email` | ➖ | |
| `phone` | ➖ | |
| `department` | ➖ | Must exactly match an existing department name |
| `designation` | ➖ | Job title / position |
| `site_id` | ➖ | Numeric ID shown on the import screen under "Site IDs" |
| `status` | ➖ | `active` (default) or `inactive` |
| `hire_date` | ➖ | Format: `YYYY-MM-DD` |

3. Save the file as `.csv`.
4. Drag-and-drop the file onto the upload area, or click to browse.
5. The system shows a **preview** with colour-coded rows:
   - Green = inserted (new employees)
   - Blue = updated (existing employees matched by code)
   - Red = failed (validation errors shown per row)
6. Review, then click **Confirm Import**.

---

## 8. Step 5 — Face Enrollment

**Why:** Each employee must have face data before the Jetson camera can recognise them for attendance.

There are three ways:

---

### Method A — HR Sends Enrollment Invite (Wizard)

**Where:** People / Employees → select employee(s) → **Send Enrollment Invite**  
OR from the new employee success screen → **Enroll Face**

The **Enrollment Wizard** has 4 steps shown as a progress bar at the top:

| Step | What happens |
|------|-------------|
| **1. Review** | Shows the list of selected employees. Confirm you have the right people. |
| **2. Consent** | Tick the checkbox: *"I confirm employees have been informed of this biometric data collection process."* This is mandatory. |
| **3. Send** | System dispatches enrollment email links to each employee. A spinner shows progress. |
| **4. Done** | Summary shows: **Sent** (green) / **Failed** (red) counts. Click **Close**. |

---

### Method B — Employee Self-Enrollment (via Email Link)

When the employee receives the email, they click the link which opens the **Self-Enrollment Portal** in any browser. No login required — the link contains a secure token.

The portal has 5 steps shown in a progress bar:

| Step | Screen label | What the employee does |
|------|-------------|------------------------|
| **1. Consent** | "Consent" | Reads the biometric data notice. Ticks: *"I agree to the collection and processing of my biometric data..."* Clicks **I Agree & Continue**. |
| **2. Photo Capture** | "Photo" | System activates the camera. The employee captures **8 face angles** one by one: |
| | ↳ **Front** | Look straight at camera |
| | ↳ **Left** | Turn face to the left |
| | ↳ **Right** | Turn face to the right |
| | ↳ **Up** | Tilt head slightly up |
| | ↳ **Look Up High** | Tilt head significantly up toward the ceiling |
| | ↳ **Left-Up** | Turn face left and tilt up simultaneously |
| | ↳ **Right-Up** | Turn face right and tilt up simultaneously |
| | ↳ **Down** | Tilt head slightly down |
| **3. Review** | "Review" | Sees all 8 captured photos. Quality % shown under each. Can click **Retake** on any photo. |
| **4. Submit** | "Submit" | Clicks **Submit Enrollment**. Photos sent to server. |
| **5. Done** | "Done" | Confirmation screen — enrollment complete. |

**Photo quality thresholds:**
| Score | Indicator | Action |
|-------|-----------|--------|
| ≥ 75% | "Great shot ✓" (green toast) | Accept |
| 55–74% | "Acceptable" (blue toast) | Acceptable — retake for better accuracy |
| < 55% | "Poor quality" (amber toast) | Retake required before submitting |

The **Submit** button is disabled if any photo is below the acceptable threshold.

---

### Method C — Bulk Enrollment Invite

**Where:** People / Employees → tick checkboxes on multiple employees → **Send Enrollment Invite** (bulk action bar)

Sends the email link to all selected employees simultaneously. Track their status in Section 9.

---

## 9. Step 6 — Track Enrollment Status

**Where to go:** Sidebar → **Enrollment** → **Remote Enrollment Manager**

This page lists all enrollment invitations sent, with their current status:

| Status badge | Meaning |
|-------------|---------|
| **Pending** | Email sent, employee has not opened it yet |
| **Opened** | Employee opened the email link |
| **In Progress** | Employee started capturing photos |
| **Completed** | Photos submitted successfully |
| **Pending Embedding** | Photos received — Jetson device is building the face model |
| **Approved** | Face model built and activated on the device |
| **Expired** | Link expired before employee completed enrollment — resend required |

### Actions on this page
- **Resend** — Resend the invite to a specific employee
- **Resend All Pending** — Resend to everyone with Pending or Expired status
- **Revoke** — Cancel an outstanding invite
- **Search** — Search by name, employee code, or email
- **Filter checkboxes** — Filter by status or select employees for bulk resend

### Pending Enrollment Approvals
**Where:** Sidebar → **Enrollment** → **Pending Approvals**

If your organisation requires HR approval before face models go live, completed enrollments appear here for review before they are pushed to the Jetson device.

---

# DAILY OPERATIONS

---

## 10. HR Overview Dashboard

**Where to go:** Sidebar → **HR Overview** (default landing page after login)

### Top Summary Strip
| Metric | Colour | What it means |
|--------|--------|---------------|
| **Present** | Green number | Employees who have checked in today |
| **Late** | Amber number | Checked in after shift start + grace period |
| **Absent** | Red number | No check-in recorded yet |

### Attendance % Bar (horizontal bar)
- **Green** segment = On-time arrivals
- **Amber** segment = Late arrivals
- **Red** segment = Not in yet

### Zone Activity Heatmap
Shows which physical floor zones are occupied right now, during business hours.

### 30-Day Attendance Trend (bar chart)
- **Each bar** = one day
- **Green** = Present
- **Amber** = Late
- **Red** = Absent
- Hover over any bar for exact counts

### Department Breakdown (bar chart, right panel)
- One bar group per department
- Green / Amber / Red stacks per department
- Hover for department name and counts

### Dashboard Tabs

| Tab | What it switches to |
|-----|---------------------|
| **Daily** | Today's live snapshot (default) |
| **Monthly** | Monthly attendance grid (all employees, all days of selected month) |
| **Analytics** | Charts, trends, department comparisons |

---

## 11. Daily Attendance — Roster View

**Where to go:** Sidebar → **Attendance** (or HR Overview → `Daily` tab)

### Controls (top of page)

| Control | Purpose |
|---------|---------|
| **Date picker** | Select any single date to view |
| **Range picker** | Set a From → To date range for multi-day views |
| **Status tabs** | Filter roster by: `On Time` · `Late` · `Not IN Yet` |
| **Department dropdown** | Show one department only |
| **Search bar** | Type employee name or department to filter |
| **Columns toggle** | Show/hide individual columns via the column selector button |
| **Density toggle** | `Comfortable` (taller rows, photos visible) / `Compact` (denser rows) |

### KPI Strip (above roster table)

| Metric | Meaning |
|--------|---------|
| **Attendance %** | (Present + Late) ÷ total active employees × 100 |
| **Punctuality %** | On-time arrivals ÷ (Present + Late) × 100 |
| **Avg Hours** | Average working hours across present employees |
| **Currently In** | Live count — employees inside the building right now (pulsing green dot) |

### Roster Table Columns (toggleable)

| Column | Description |
|--------|-------------|
| Employee | Name + avatar initials |
| Department | Assigned department |
| Location | Office zone label |
| Shift | Assigned shift name |
| Status | Present · Late · Absent · On Break · Weekend |
| Check-in | Time of first camera recognition |
| Check-out | Time of last camera recognition |
| Duration | Gross time in office (check-out minus check-in) |
| Break | Calculated break time |
| Proof | Camera photo thumbnails (click to zoom) |

### Row Actions

| Icon | Action |
|------|--------|
| **▶ expand** | Expand row to see break segment detail, photo proofs |
| **person icon** | Open full Employee Profile |
| **calendar icon** | Open this employee's timesheet drawer |

### Expanded Row Detail
Click the arrow on any employee row to expand it:
- Check-in and check-out timestamps
- **Break segments** with exact from → to times and duration:
  - 🟢 Green dot = **confirmed** (camera captured both the exit and return)
  - 🟡 Amber dot = **~est · camera gap** (no exit captured; inferred from a gap >30 min between two check-ins)
- Click any **photo thumbnail** to view full-size

### Regularization / Correction (from roster)
If an employee's record is wrong, click the **edit icon** (pencil) on their row → enter corrected check-in / check-out times and click **Save**.

---

## 12. Punch Details Modal

**How to open:** Click any employee's **date cell** in the Monthly Grid, the Calendar view, or the expanded row **Details** button.

### Modal tabs

| Tab | Shows |
|-----|-------|
| **Summary** | Check-in time, Check-out time, Status, Working Hours, Break time (formatted as Xh Ym), Duration |
| **Timeline** | All individual punch events (every camera hit) in chronological order, filterable by `All` / `Check-ins` / `Check-outs` |
| **Photos** | All captured photos for the day with timestamps |

### Summary section breakdown
- **Check In:** First recognition time
- **Check Out:** Last recognition time
- **Status:** Present / Late / Absent / On Break
- **Working Hours:** Net hours (gross − break)
- **Break:** Total break with per-segment breakdown below:
  - Each segment shows: Start → End · Duration · Confirmed/Estimated badge
- **Duration:** Gross time (check-out − check-in)

### Photos tab
- Proof photos shown as thumbnails
- Click any photo → full-screen zoom view
- Press Esc or click backdrop to close

---

## 13. Live Office Intelligence

**Where to go:** Sidebar → **Live Office Intelligence**

Shows a live table of every employee currently inside the building (those with a check-in but no check-out today).

### Filters (top of table)

| Filter | How |
|--------|-----|
| Search | Type name or code |
| Status | Dropdown: All / Present / Late / On Break |
| Department | Dropdown: All or specific department |

### Table columns
Name · Department · Location · Check-in Time · Duration in Office · Status

---

## 14. Presence Monitor

**Where to go:** Sidebar → **Presence Monitor**

Similar to Live Office Intelligence but with a different layout and summary tiles at the top:

| Tile | Shows |
|------|-------|
| **Total Present** | Everyone checked in today |
| **On Time** | Arrived before grace period |
| **Late Arrivals** | Arrived after grace period |
| **On Break** | Currently in a break period |

Search by employee name and filter by Status or Department. The table auto-refreshes.

---

# RECORDS & HISTORY

---

## 15. Monthly Attendance Grid

**Where to go:** Sidebar → **Attendance** → `Monthly` tab  
OR  
HR Overview → `Monthly` tab

### What you see
A matrix with **employees as rows** and **days of the month as columns**. Each cell is colour-coded:

| Letter | Colour | Meaning |
|--------|--------|---------|
| **P** | Green | Present |
| **L** | Amber | Late |
| **A** | Red | Absent |
| **R** | Sky blue | WFH (Remote) |
| **V** | Indigo | On Leave |
| **H** | Violet | Holiday |
| **W** | Grey | Weekly Off |

### Quick Filters (above the grid)

| Filter | Shows |
|--------|-------|
| **All** | Everyone |
| **Has absences** | Employees with at least one Absent day |
| **Frequent late (3+)** | Employees late 3 or more times this month |
| **Below 75%** | Employees with attendance rate under 75% |

### KPI tiles (above grid)

| Tile | Meaning |
|------|---------|
| Avg attendance % | Month average across all employees |
| Present (man-days) | Total present day-slots |
| Late (man-days) | Total late day-slots |
| Absent (man-days) | Total absent day-slots |
| Perfect (100%) | Number of employees with zero absences |

### Month navigation
Use the **← →** arrows to move between months.

### Drill-down
Click any **coloured cell** → opens the **Punch Details Modal** for that employee on that day.

---

## 16. Attendance Calendar

**Where to go:** Sidebar → **Attendance** → Calendar view (or from HR dashboard)

A traditional month calendar with attendance events overlaid per day:
- Each day cell shows a coloured dot (green/amber/red) for each employee
- Holidays appear as labelled banners across the day cell

**Controls:**
- ← → arrows: Previous / Next month
- Click any **day**: Opens a side panel showing all employees' status for that day + device activity heatmap for the day

---

## 17. Employee Profile

**Where to open:**  
- People/Employees → click any employee row  
- Attendance roster → click employee name link

### Left Rail

| Card | Fields shown |
|------|-------------|
| **Identity** | Email · Phone · Location |
| **Employment** | Department · Shift · Join Date |
| **Biometric Enrollment** | Number of face angles enrolled (expected: 8) · Consent status (Consent ✓ / Withdrawn / No consent) |

### Stat cards (row of 4)

| Stat | Meaning |
|------|---------|
| Attendance Rate | % of working days the employee was present (last 30 records) |
| Days Present | Total present days |
| Late Arrivals | Number of late days |
| Early Departures | Days left before scheduled end time |
| Avg Hours/Day | Average working hours across recent records |

### Attendance History Table (main area)
One row per working day:

| Column | Description |
|--------|-------------|
| Date | Working date |
| Check-in | First recognition time |
| Check-out | Last recognition time |
| Status | Present · Late · Absent · On Break |
| Working Hours | Net hours (formatted Xh Ym) |
| Break | Break duration |
| Accuracy | Face recognition confidence % |
| Photo | Thumbnail proof — click to zoom |

Click any **row** → opens **Punch Details Modal** for that day.

### Deactivate Employee
Click the **status toggle** on the profile (Active → Inactive) to deactivate. Their historical records are retained.

### GDPR Data Erasure
The **shield/delete icon** in the profile header permanently deletes all biometric and personal data. A confirmation modal is shown. This cannot be undone.

---

## 18. Employee Timesheet Drawer

**How to open:** Attendance roster → row action calendar icon  
OR  
Employee Profile → click any historical row

Slides in from the right. Shows a **monthly calendar view for that specific employee**:

| Day colour | Status |
|-----------|--------|
| Green | Present |
| Amber | Late |
| Red | Absent |
| Sky blue | WFH |
| Indigo | On Leave |
| Violet | Holiday |
| Grey | Off (Weekend) |

Legend shown at the top of the drawer. Click any day to see the check-in and check-out times for that day.

---

# ANALYTICS

---

## 19. Attendance Analytics

**Where to go:** Sidebar → **Attendance** → `Analytics` tab  
OR  
HR Overview → `Analytics` tab

### Available charts

| Chart | What it shows |
|-------|---------------|
| **Monthly Trend** | 30-day bar chart: Present / Late / Absent stacked per day. Target 90% line shown. |
| **Department Attendance** | Side-by-side bars per department — green/amber/red breakdown |
| **Top Late Arrivals** | List of employees with the most late marks this month |
| **Attendance Rate Gauge** | Circular gauge showing overall attendance % vs target |

### Filters on Analytics
- **Month selector** — navigate to any past month
- **Department filter** — isolate one department

---

## 20. Multi-Employee Analysis

**Where to go:** Sidebar → **Analytics** → Multi-Employee Analysis

Compare up to multiple employees side-by-side:
1. Use the **employee selector** (search + checkboxes) to pick 2–10 employees.
2. The comparison table shows each employee's monthly stats in columns:
   - Present days · Late days · Absent days · Avg hours · Attendance %
3. A trend chart overlays their 30-day attendance lines.

---

## 21. Departments & Shifts Analytics

**Where to go:** Sidebar → **Departments & Shifts** → `Roster` tab

Shows a combined roster grouped by department and shift, with today's status visible per employee:

| Column | Description |
|--------|-------------|
| Employee Name | Full name with avatar |
| Shift | Assigned shift |
| Check-in | Today's check-in time |
| Check-out | Today's check-out time |
| Status | Present / Late / Absent |
| Duration | Time in office |

Unassigned employees (no department or no shift) appear in a separate highlighted section at the top as a reminder to complete their setup.

---

# EXPORTS & REQUESTS

---

## 22. Exporting Attendance Data

**Where to go:** Sidebar → **Attendance** → **Export** button (download icon, top-right of roster)

### Format options

| Format | Use when |
|--------|---------|
| **Excel (.xlsx)** | Want formatted file with embedded check-in/check-out photos, colour-coded rows by status — for management reports |
| **CSV (.csv)** | Want a plain data file to import into other systems — photos are accessible URLs |

### Columns in both exports
`Name · Code · Department · Date · Check In · Check Out · Status · Hours (hrs) · Overtime (hrs) · Late · Break · Check-In Photo · Check-Out Photo`

### Applying Filters Before Exporting
The export **honours whatever is currently filtered** on the roster screen:

| Filter | Where to set it |
|--------|----------------|
| Date or date range | Date picker at the top |
| Status | On Time / Late / Not IN Yet tabs |
| Department | Department dropdown |
| Search term | Search bar (name/department) |

Click **Export → Excel (.xlsx)** or **Export → CSV** — the file downloads immediately.

> **Limit:** Maximum 180 days per export.

---

## 23. Regularization Requests

When an employee submits an attendance correction (e.g. "camera missed me at entry, please mark me Present"), it appears here.

**Where to go:** Attendance roster → **Pending Requests** badge (shown when requests exist)

### Per-request information shown
- Employee name and date
- Current record (what the system has)
- Requested correction (what the employee says it should be)

### Actions

| Action | Result |
|--------|--------|
| **Approve** | Attendance record updated with the corrected check-in / check-out |
| **Reject** | Request dismissed; record stays unchanged |

After reviewing multiple requests, click **Save All** to commit all approvals at once.

---

## 24. Enrollment History Log

**Where to go:** Sidebar → **Enrollment** → **Enrollment History**

A chronological audit log of every enrollment action taken:

| Column | Shows |
|--------|-------|
| Employee | Who was enrolled |
| Action | e.g. "Enrolled", "Re-enrolled", "Revoked" |
| Details | Number of angles, quality score |
| Performed By | Which HR user or the employee themselves |
| Timestamp | Exact date and time of the action |

Use this to audit who enrolled whom and when.

---

# REFERENCE

---

## 25. Quick Reference — All Field Definitions

| Term | Definition |
|------|-----------|
| **Workspace slug** | The unique short name for your company's instance of the platform. Given by your admin (e.g. `acme-corp`). |
| **Employee Code** | Unique alphanumeric ID for each employee (e.g. `MLII90`). Must not be repeated. Used in CSV imports and exports. |
| **Grace Period** | Minutes after shift start time before the system marks an employee "Late". Set per shift. |
| **Break Duration** | Time between an OUT ping and the next IN ping. If no exit was captured by camera, a break is inferred when two consecutive IN pings are more than 30 minutes apart. |
| **Working Hours** | Gross session duration (check-out − check-in) minus all break time. |
| **Camera Gap** | When the exit camera fails to capture an employee leaving. The system infers a break equal to the gap between two IN pings when the gap exceeds 30 minutes. |
| **Recognition Accuracy** | The face-match confidence % returned by the Jetson camera device (0–100%). |
| **Enrollment** | The process of capturing 8 face angles to build a recognition model. Required before a camera can identify the employee. |
| **Embedding** | The mathematical face representation stored on the Jetson device after enrollment. Expected: 8 embeddings (one per angle). |
| **Consent** | Employee's explicit agreement to biometric data collection. Required before enrollment can proceed. States: Consent ✓ / Withdrawn / No consent. |
| **Present** | Employee has at least one check-in today. |
| **Late** | Employee checked in after shift start time + grace period minutes. |
| **Absent** | No check-in recorded for the working day. |
| **Weekend / Off** | The day falls outside the employee's configured work days in their shift. |
| **WFH (R)** | Employee marked as working from home for the day. |
| **On Leave (V)** | Employee on approved leave. |
| **Holiday (H)** | Organisation-wide holiday. |
| **Regularization** | An attendance correction request submitted by an employee when the camera system did not capture their actual attendance correctly. |
| **Site** | A physical office location. Employees and devices are scoped to a site. Multi-site organisations manage each site separately. |
| **Jetson Device** | The NVIDIA Jetson edge camera hardware installed at entry/exit doors. Runs face recognition locally and sends events to the platform. |

---

## 26. Status Colour Legend

| Colour | Status | Where it appears |
|--------|--------|-----------------|
| 🟢 Green | Present (on time) | Roster, Monthly Grid (P), KPI bar |
| 🟡 Amber | Late arrival | Roster, Monthly Grid (L), KPI bar |
| 🔴 Red | Absent | Roster, Monthly Grid (A), KPI bar |
| 🔵 Sky blue | WFH (Remote) | Monthly Grid (R) |
| 🟣 Indigo | On Leave | Monthly Grid (V) |
| 🟣 Violet | Holiday | Monthly Grid (H) |
| ⚪ Grey | Weekend / Off | Monthly Grid (W) |
| 🟢 Green dot (break) | Confirmed break (camera captured exit + return) | Expanded roster row, Punch Details |
| 🟡 Amber dot (break) | Estimated break (~est · camera gap) | Expanded roster row, Punch Details |

---

*For device setup, camera installation, ZTP activation, or system administration tasks, refer to the **Admin User Manual**.*  
*For Jetson device pairing, watchlist management, or AI confidence settings, refer to the **Operations Manual**.*  
*Technical support: contact your system administrator or raise a ticket at your company's support portal.*
