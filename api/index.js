/**
 * Zoho People MCP Server — Vercel Serverless + OAuth
 *
 * Deploys as a single Vercel serverless function.
 * Uses STATELESS Streamable HTTP transport (no in-memory sessions).
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server  → OAuth discovery
 *   GET  /authorize    → Redirect to Zoho consent page
 *   POST /token        → Proxy token exchange to Zoho
 *   POST /register     → Dynamic client registration (MCP spec)
 *   POST /mcp          → MCP JSON-RPC (requires Bearer token)
 *   GET  /mcp          → MCP SSE (server-to-client stream)
 *   DELETE /mcp        → Session teardown
 *   GET  /             → Health check
 */

import express from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ZohoClient } from "../src/zoho-client.js";

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const VALID_DOMAINS = ["com", "eu", "in", "com.au", "jp"];
const RAW_DOMAIN = (process.env.ZOHO_DOMAIN || "in").trim().toLowerCase().replace(/^\./, "");
const ZOHO_DOMAIN = VALID_DOMAINS.includes(RAW_DOMAIN) ? RAW_DOMAIN : "in";

const ZOHO_ACCOUNTS = {
  com: "https://accounts.zoho.com",
  eu: "https://accounts.zoho.eu",
  in: "https://accounts.zoho.in",
  "com.au": "https://accounts.zoho.com.au",
  jp: "https://accounts.zoho.jp",
};
const ZOHO_PEOPLE = {
  com: "https://people.zoho.com",
  eu: "https://people.zoho.eu",
  in: "https://people.zoho.in",
  "com.au": "https://people.zoho.com.au",
  jp: "https://people.zoho.jp",
};
const ACCOUNTS_URL = ZOHO_ACCOUNTS[ZOHO_DOMAIN];
const PEOPLE_URL = ZOHO_PEOPLE[ZOHO_DOMAIN];

const ZOHO_SCOPES = [
  "ZOHOPEOPLE.forms.ALL",
  "ZOHOPEOPLE.attendance.ALL",
  "ZOHOPEOPLE.leave.ALL",
  "ZOHOPEOPLE.timetracker.ALL",
  "ZOHOPEOPLE.dashboard.ALL",
].join(",");

// Optional: server-stored Zoho OAuth credentials.
// If set, users don't need to paste Client ID/Secret in Claude Advanced Settings.
const SERVER_CLIENT_ID = process.env.ZOHO_CLIENT_ID || null;
const SERVER_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || null;
const HAS_SERVER_CREDS = Boolean(SERVER_CLIENT_ID && SERVER_CLIENT_SECRET);

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (_req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "zoho-people-mcp",
    version: "1.0.0",
    status: "running",
    tools: 26,
    transport: "streamable-http",
    oauth: true,
    zoho_domain: ZOHO_DOMAIN,
    zoho_domain_source: process.env.ZOHO_DOMAIN ? "env" : "default",
    accounts_url: ACCOUNTS_URL,
    people_api_url: `${PEOPLE_URL}/people/api`,
    server_credentials_configured: HAS_SERVER_CREDS,
    hint: "Your Zoho account's data center (see URL bar on people.zoho.*) MUST match zoho_domain. Mismatch → error 7201.",
  });
});

// ─────────────────────────────────────────────
// OAuth Discovery
// ─────────────────────────────────────────────

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const serverUrl = process.env.PUBLIC_URL || `${proto}://${host}`;

  const meta = {
    issuer: serverUrl,
    authorization_endpoint: `${serverUrl}/authorize`,
    token_endpoint: `${serverUrl}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: ZOHO_SCOPES.split(","),
  };
  // Advertise DCR when server has creds (so Claude auto-registers with our Zoho app)
  // or when explicitly enabled.
  if (HAS_SERVER_CREDS || process.env.ENABLE_DCR === "true") {
    meta.registration_endpoint = `${serverUrl}/register`;
  }
  res.json(meta);
});

// RFC 9728 — OAuth Protected Resource metadata (required by MCP authorization spec)
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const serverUrl = process.env.PUBLIC_URL || `${proto}://${host}`;
  res.json({
    resource: serverUrl,
    authorization_servers: [serverUrl],
    scopes_supported: ZOHO_SCOPES.split(","),
    bearer_methods_supported: ["header"],
  });
});
// Some clients probe with the resource path appended.
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const serverUrl = process.env.PUBLIC_URL || `${proto}://${host}`;
  res.json({
    resource: `${serverUrl}/mcp`,
    authorization_servers: [serverUrl],
    scopes_supported: ZOHO_SCOPES.split(","),
    bearer_methods_supported: ["header"],
  });
});

// ─────────────────────────────────────────────
// Dynamic Client Registration (MCP spec)
// ─────────────────────────────────────────────

app.post("/register", express.json(), (req, res) => {
  const body = req.body || {};
  // When the server holds Zoho creds, hand them back so Claude uses our pre-registered app.
  const client_id = HAS_SERVER_CREDS ? SERVER_CLIENT_ID : (body.client_id || crypto.randomUUID());
  const client_secret = HAS_SERVER_CREDS ? SERVER_CLIENT_SECRET : body.client_secret;
  res.status(201).json({
    client_id,
    client_secret,
    client_name: body.client_name || "Claude Desktop",
    redirect_uris: body.redirect_uris || [],
    grant_types: body.grant_types || ["authorization_code", "refresh_token"],
    response_types: body.response_types || ["code"],
    token_endpoint_auth_method: body.token_endpoint_auth_method || "client_secret_post",
  });
});

// ─────────────────────────────────────────────
// Authorize → redirect to Zoho consent page
// ─────────────────────────────────────────────

app.get("/authorize", (req, res) => {
  const { client_id: qClientId, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
  const client_id = HAS_SERVER_CREDS ? SERVER_CLIENT_ID : qClientId;

  const zohoUrl = new URL(`${ACCOUNTS_URL}/oauth/v2/auth`);
  zohoUrl.searchParams.set("client_id", client_id);
  zohoUrl.searchParams.set("redirect_uri", redirect_uri);
  zohoUrl.searchParams.set("response_type", response_type || "code");
  zohoUrl.searchParams.set("scope", ZOHO_SCOPES);
  zohoUrl.searchParams.set("access_type", "offline");
  zohoUrl.searchParams.set("prompt", "consent");
  if (state) zohoUrl.searchParams.set("state", state);
  if (code_challenge) zohoUrl.searchParams.set("code_challenge", code_challenge);
  if (code_challenge_method) zohoUrl.searchParams.set("code_challenge_method", code_challenge_method);

  res.redirect(zohoUrl.toString());
});

// ─────────────────────────────────────────────
// Token → proxy to Zoho (handles both auth_code + refresh)
// ─────────────────────────────────────────────

app.post("/token", express.urlencoded({ extended: false }), async (req, res) => {
  const { grant_type, code, client_id: bClientId, client_secret: bClientSecret, redirect_uri, code_verifier, refresh_token } = req.body;

  // Prefer server-stored creds when configured; ignore whatever the client sent.
  const client_id = HAS_SERVER_CREDS ? SERVER_CLIENT_ID : bClientId;
  const client_secret = HAS_SERVER_CREDS ? SERVER_CLIENT_SECRET : bClientSecret;

  const form = new URLSearchParams();
  form.set("grant_type", grant_type);
  if (code) form.set("code", code);
  if (client_id) form.set("client_id", client_id);
  if (client_secret) form.set("client_secret", client_secret);
  if (redirect_uri) form.set("redirect_uri", redirect_uri);
  if (code_verifier) form.set("code_verifier", code_verifier);
  if (refresh_token) form.set("refresh_token", refresh_token);

  try {
    const zohoRes = await fetch(`${ACCOUNTS_URL}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const text = await zohoRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (data.error || !data.access_token) {
      console.error("[/token] Zoho rejected:", {
        status: zohoRes.status,
        grant_type,
        accounts_url: ACCOUNTS_URL,
        response: data,
      });
      return res.status(400).json({
        error: data.error || "invalid_grant",
        error_description: data.error_description ||
          `Zoho ${ACCOUNTS_URL} returned: ${JSON.stringify(data)}. ` +
          `Check: (1) Client ID/Secret match ${ACCOUNTS_URL.replace("accounts", "api-console")}, ` +
          `(2) redirect URI is exactly "https://claude.ai/api/mcp/auth_callback", ` +
          `(3) app type is "Server-based Application".`,
      });
    }
    res.status(zohoRes.status).json(data);
  } catch (err) {
    console.error("[/token] network error:", err);
    res.status(502).json({ error: "token_exchange_failed", error_description: err.message });
  }
});

// ─────────────────────────────────────────────
// MCP Server Factory (26 tools)
// ─────────────────────────────────────────────

function createMcpServer(zohoClient) {
  const server = new McpServer({ name: "zoho-people-mcp", version: "1.0.0" });

  const ok = (d) => ({ content: [{ type: "text", text: typeof d === "string" ? d : JSON.stringify(d, null, 2) }] });
  const fail = (m) => ({ content: [{ type: "text", text: `Error: ${m}` }], isError: true });

  // ── EMPLOYEES ──
  server.tool("get_employees", "Fetch employee list with pagination.", {
    index: z.number().optional().default(1).describe("Start index (default 1)"),
    limit: z.number().optional().default(200).describe("Max records (max 200)"),
  }, async ({ index, limit }) => { try { return ok(await zohoClient.getEmployees(index, limit)); } catch (e) { return fail(e.message); } });

  server.tool("get_employee_by_id", "Fetch employee by record ID.", {
    recordId: z.string().describe("Employee record ID"),
  }, async ({ recordId }) => { try { return ok(await zohoClient.getEmployeeById(recordId)); } catch (e) { return fail(e.message); } });

  server.tool("search_employees", "Search employees by field.", {
    searchColumn: z.string().describe("Field name (EmailID, Department, FirstName)"),
    searchValue: z.string().describe("Value to search"),
  }, async ({ searchColumn, searchValue }) => { try { return ok(await zohoClient.searchEmployees(searchColumn, searchValue)); } catch (e) { return fail(e.message); } });

  server.tool("create_employee", "Create new employee.", {
    firstName: z.string(), lastName: z.string(), emailId: z.string(),
    department: z.string().optional(), designation: z.string().optional(),
    dateOfJoining: z.string().optional().describe("yyyy-MM-dd"),
    employeeId: z.string().optional(),
    additionalFields: z.record(z.string()).optional(),
  }, async ({ firstName, lastName, emailId, department, designation, dateOfJoining, employeeId, additionalFields }) => {
    try {
      const d = { FirstName: firstName, LastName: lastName, EmailID: emailId };
      if (department) d.Department = department;
      if (designation) d.Designation = designation;
      if (dateOfJoining) d.Dateofjoining = dateOfJoining;
      if (employeeId) d.EmployeeID = employeeId;
      if (additionalFields) Object.assign(d, additionalFields);
      return ok(await zohoClient.createEmployee(JSON.stringify(d)));
    } catch (e) { return fail(e.message); }
  });

  server.tool("update_employee", "Update employee fields.", {
    recordId: z.string(), fields: z.record(z.string()),
  }, async ({ recordId, fields }) => { try { return ok(await zohoClient.updateEmployee(recordId, JSON.stringify(fields))); } catch (e) { return fail(e.message); } });

  // ── ATTENDANCE ──
  server.tool("attendance_check_in", "Record check-in.", {
    empId: z.string().describe("Employee ID or email"), checkInTime: z.string().optional().describe("yyyy-MM-dd HH:mm:ss"),
  }, async ({ empId, checkInTime }) => { try { return ok(await zohoClient.checkIn(empId, checkInTime)); } catch (e) { return fail(e.message); } });

  server.tool("attendance_check_out", "Record check-out.", {
    empId: z.string().describe("Employee ID or email"), checkOutTime: z.string().optional().describe("yyyy-MM-dd HH:mm:ss"),
  }, async ({ empId, checkOutTime }) => { try { return ok(await zohoClient.checkOut(empId, checkOutTime)); } catch (e) { return fail(e.message); } });

  server.tool("get_attendance_report", "Get attendance summary for date range.", {
    empId: z.string(), startDate: z.string().describe("yyyy-MM-dd"), endDate: z.string().describe("yyyy-MM-dd"),
  }, async ({ empId, startDate, endDate }) => { try { return ok(await zohoClient.getAttendance(empId, startDate, endDate)); } catch (e) { return fail(e.message); } });

  server.tool("get_attendance_entries", "Get detailed check-in/out entries.", {
    empId: z.string(), startDate: z.string().describe("yyyy-MM-dd"), endDate: z.string().describe("yyyy-MM-dd"),
  }, async ({ empId, startDate, endDate }) => { try { return ok(await zohoClient.getAttendanceEntries(empId, startDate, endDate)); } catch (e) { return fail(e.message); } });

  server.tool("bulk_import_attendance", "Bulk import attendance records.", {
    data: z.string().describe("JSON attendance data array"),
  }, async ({ data }) => { try { return ok(await zohoClient.bulkImportAttendance(data)); } catch (e) { return fail(e.message); } });

  // ── SHIFTS ──
  server.tool("get_shift_configuration", "Get shift schedule for employee.", {
    empId: z.string(), startDate: z.string(), endDate: z.string(),
  }, async ({ empId, startDate, endDate }) => { try { return ok(await zohoClient.getShiftConfiguration(empId, startDate, endDate)); } catch (e) { return fail(e.message); } });

  server.tool("assign_shift", "Assign shift to employee.", {
    empId: z.string(), shiftName: z.string(), fromDate: z.string(), toDate: z.string(),
  }, async ({ empId, shiftName, fromDate, toDate }) => { try { return ok(await zohoClient.updateUserShift(empId, shiftName, fromDate, toDate)); } catch (e) { return fail(e.message); } });

  // ── LEAVE ──
  server.tool("get_leave_types", "Get available leave types.", {
    userId: z.string(),
  }, async ({ userId }) => { try { return ok(await zohoClient.getLeaveTypes(userId)); } catch (e) { return fail(e.message); } });

  server.tool("get_leave_records", "Fetch leave records.", {
    userId: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional(),
  }, async ({ userId, startDate, endDate }) => { try { return ok(await zohoClient.getLeaveRecords(userId, startDate, endDate)); } catch (e) { return fail(e.message); } });

  server.tool("apply_leave", "Apply for leave.", {
    employeeId: z.string(), leaveType: z.string(), from: z.string(), to: z.string(),
    reason: z.string().optional(), additionalFields: z.record(z.string()).optional(),
  }, async ({ employeeId, leaveType, from, to, reason, additionalFields }) => {
    try {
      const d = { Employee_ID: employeeId, Leave_Type: leaveType, From: from, To: to };
      if (reason) d.Reason = reason;
      if (additionalFields) Object.assign(d, additionalFields);
      return ok(await zohoClient.applyLeave(JSON.stringify(d)));
    } catch (e) { return fail(e.message); }
  });

  server.tool("get_leave_balance", "Get leave balance.", {
    userId: z.string().optional(),
  }, async ({ userId }) => { try { return ok(await zohoClient.getLeaveBalance(userId)); } catch (e) { return fail(e.message); } });

  server.tool("get_leave_user_report", "Get leave report for current year.", {
    userId: z.string().optional(),
  }, async ({ userId }) => { try { return ok(await zohoClient.getLeaveUserReport(userId)); } catch (e) { return fail(e.message); } });

  // ── DEPARTMENTS ──
  server.tool("get_departments", "Fetch all departments.", {
    index: z.number().optional().default(1), limit: z.number().optional().default(200),
  }, async ({ index, limit }) => { try { return ok(await zohoClient.getDepartments(index, limit)); } catch (e) { return fail(e.message); } });

  server.tool("create_department", "Create department.", {
    departmentName: z.string(), parentDepartment: z.string().optional(), additionalFields: z.record(z.string()).optional(),
  }, async ({ departmentName, parentDepartment, additionalFields }) => {
    try {
      const d = { Department_Name: departmentName };
      if (parentDepartment) d.Parent_Department = parentDepartment;
      if (additionalFields) Object.assign(d, additionalFields);
      return ok(await zohoClient.createDepartment(JSON.stringify(d)));
    } catch (e) { return fail(e.message); }
  });

  // ── DESIGNATIONS ──
  server.tool("get_designations", "Fetch all designations.", {
    index: z.number().optional().default(1), limit: z.number().optional().default(200),
  }, async ({ index, limit }) => { try { return ok(await zohoClient.getDesignations(index, limit)); } catch (e) { return fail(e.message); } });

  // ── TIMESHEETS ──
  server.tool("get_timesheets", "Fetch timesheet entries.", {
    empId: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional(),
  }, async ({ empId, startDate, endDate }) => { try { return ok(await zohoClient.getTimesheets(empId, startDate, endDate)); } catch (e) { return fail(e.message); } });

  server.tool("add_time_log", "Add time log.", {
    empId: z.string(), projectId: z.string(), jobId: z.string(), workDate: z.string(), hours: z.number(), description: z.string().optional(),
  }, async ({ empId, projectId, jobId, workDate, hours, description }) => { try { return ok(await zohoClient.addTimeLog(empId, projectId, jobId, workDate, hours, description)); } catch (e) { return fail(e.message); } });

  server.tool("get_timesheet_projects", "List projects for time tracking.", {},
    async () => { try { return ok(await zohoClient.getTimesheetProjects()); } catch (e) { return fail(e.message); } });

  server.tool("get_timesheet_jobs", "List jobs for time tracking.", {},
    async () => { try { return ok(await zohoClient.getTimesheetJobs()); } catch (e) { return fail(e.message); } });

  // ── GENERIC FORMS ──
  server.tool("get_form_records", "Fetch records from any Zoho People form.", {
    formLinkName: z.string(), index: z.number().optional().default(1), limit: z.number().optional().default(200),
    searchColumn: z.string().optional(), searchValue: z.string().optional(),
  }, async ({ formLinkName, index, limit, searchColumn, searchValue }) => {
    try {
      const p = { sIndex: `${index}`, limit: `${limit}` };
      if (searchColumn) p.searchColumn = searchColumn;
      if (searchValue) p.searchValue = searchValue;
      return ok(await zohoClient.request(`/forms/json/${formLinkName}/getRecords`, { params: p }));
    } catch (e) { return fail(e.message); }
  });

  server.tool("get_form_record_by_id", "Fetch single record from any form.", {
    formLinkName: z.string(), recordId: z.string(),
  }, async ({ formLinkName, recordId }) => {
    try { return ok(await zohoClient.request(`/forms/json/${formLinkName}/getDataByID`, { params: { recordId } })); } catch (e) { return fail(e.message); }
  });

  return server;
}

// ─────────────────────────────────────────────
// MCP Endpoint — STATELESS (Vercel-compatible)
// Each request creates a fresh server + transport, no in-memory sessions.
// ─────────────────────────────────────────────

async function handleMcp(req, res) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.get("host");
    const serverUrl = process.env.PUBLIC_URL || `${proto}://${host}`;
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="mcp", resource_metadata="${serverUrl}/.well-known/oauth-protected-resource"`
    );
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized — Bearer token required" },
      id: null,
    });
  }

  const token = auth.substring(7);

  try {
    const zohoClient = new ZohoClient(ZOHO_DOMAIN);
    zohoClient.accessToken = token;

    const mcpServer = createMcpServer(zohoClient);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("finish", () => {
      transport.close?.();
      mcpServer.close?.();
    });
  } catch (err) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
}

app.post("/mcp", handleMcp);
app.post("/", handleMcp);

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed in stateless mode. Use POST." });
});

app.delete("/mcp", (_req, res) => res.status(204).end());
app.delete("/", (_req, res) => res.status(204).end());

// ─────────────────────────────────────────────
// Export for Vercel + optional local listen
// ─────────────────────────────────────────────

export default app;

// If running locally (not on Vercel), start listening
const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
if (!isVercel) {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Zoho People MCP Server on http://0.0.0.0:${PORT}`);
    console.log(`Zoho domain: .${ZOHO_DOMAIN}`);
    console.log(`OAuth:  /.well-known/oauth-authorization-server`);
    console.log(`MCP:    /mcp`);
  });
}
