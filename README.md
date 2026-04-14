# Zoho People MCP Server (Vercel + OAuth)

A one-click Zoho People connector for Claude Desktop — deploy on **Vercel** for free, and get the same OAuth experience as the built-in Zoho Books/CRM connectors. Click Connect → Zoho permission page → done.

## How It Works

```
Click Connect → Zoho login → Grant permission → 26 tools available in Claude
```

The server runs as a **stateless Vercel serverless function** and proxies OAuth between Claude and Zoho. No database needed, no persistent state.

## Setup

### Step 1: Create a Zoho OAuth App

1. Go to [Zoho API Console](https://api-console.zoho.in/) (use `.com` for US, `.eu` for Europe)
2. Click **Add Client** → **Server-based Application**
3. Fill in:
   - **Client Name:** `Claude Zoho People`
   - **Homepage URL:** `https://your-app.vercel.app` (update after deploy)
   - **Authorized Redirect URI:** `https://claude.ai/api/mcp/auth_callback`
4. Save the **Client ID** and **Client Secret**

### Step 2: Deploy to Vercel

**Option A — One-click deploy (easiest):**
1. Push this project to GitHub
2. Go to [vercel.com/new](https://vercel.com/new) → Import the repo
3. Add environment variable: `ZOHO_DOMAIN` = `in`
4. Click **Deploy**

**Option B — Vercel CLI:**
```bash
npm i -g vercel
cd zoho-people-mcp
vercel --prod
# When prompted, set ZOHO_DOMAIN=in in environment variables
```

Your URL will be something like `https://zoho-people-mcp.vercel.app`

### Step 3: Add to Claude Desktop (Cowork)

1. Open Claude Desktop → **Cowork** → **Customize** → **Connectors** → click **+**
2. Fill in:
   - **Name:** `Zoho People`
   - **Remote MCP server URL:** `https://your-app.vercel.app/mcp`
3. Expand **Advanced Settings:**
   - **OAuth Client ID:** *(from Step 1)*
   - **OAuth Client Secret:** *(from Step 1)*
4. Click **Add**
5. You'll be redirected to Zoho → log in → **Accept** permissions → connected!

## Project Structure

```
zoho-people-mcp/
├── api/
│   └── index.js          ← Vercel serverless function (Express app)
├── src/
│   └── zoho-client.js    ← Zoho People API client
├── vercel.json           ← Routes all requests to api/index.js
├── package.json
└── .env.example
```

## Available Tools (26)

| Category | Tools |
|----------|-------|
| **Employees** | get_employees, get_employee_by_id, search_employees, create_employee, update_employee |
| **Attendance** | attendance_check_in, attendance_check_out, get_attendance_report, get_attendance_entries, bulk_import_attendance |
| **Shifts** | get_shift_configuration, assign_shift |
| **Leave** | get_leave_types, get_leave_records, apply_leave, get_leave_balance, get_leave_user_report |
| **Departments** | get_departments, create_department |
| **Designations** | get_designations |
| **Timesheets** | get_timesheets, add_time_log, get_timesheet_projects, get_timesheet_jobs |
| **Generic** | get_form_records, get_form_record_by_id |

## Local Development

```bash
npm install
ZOHO_DOMAIN=in node api/index.js
# Server runs at http://localhost:3000
```

## Troubleshooting

**"Invalid redirect URI" on Zoho consent page:**
Make sure the redirect URI in Zoho API Console is exactly `https://claude.ai/api/mcp/auth_callback`

**Wrong Zoho region:**
Set `ZOHO_DOMAIN` to match your account: `in` (India), `com` (US), `eu` (Europe), `com.au` (Australia), `jp` (Japan)

**Function timeout:**
Vercel free tier has 10s timeout; Pro has 60s. If Zoho API is slow, upgrade to Pro or increase `maxDuration` in vercel.json.

## License

MIT
