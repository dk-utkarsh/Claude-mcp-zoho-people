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

const ZOHO_DOMAIN = process.env.ZOHO_DOMAIN || "in";

const ZOHO_ACCOUNTS = {
  com: "https://accounts.zoho.com",
  eu: "https://accounts.zoho.eu",
  in: "https://accounts.zoho.in",
  "com.au": "https://accounts.zoho.com.au",
  jp: "https://accounts.zoho.jp",
};
const ACCOUNTS_URL = ZOHO_ACCOUNTS[ZOHO_DOMAIN] || ZOHO_ACCOUNTS.com;

const ZOHO_SCOPES = [
  "ZOHOPEOPLE.forms.ALL",
  "ZOHOPEOPLE.attendance.ALL",
  "ZOHOPEOPLE.leave.ALL",
  "ZOHOPEOPLE.timetracker.ALL",
  "ZOHOPEOPLE.dashboard.ALL",
].join(",");

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
  });
});

// ─────────────────────────────────────────────
// OAuth Discovery
// ─────────────────────────────────────────────

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const serverUrl = process.env.PUBLIC_URL || `${proto}://${host}`;

  res.json({
    issuer: serverUrl,
    authorization_endpoint: `${serverUrl}/authorize`,
    token_endpoint: `${serverUrl}/token`,
    registration_endpoint: `${serverUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: ZOHO_SCOPES.split(","),
  });
});

// ─────────────────────────────────────────────
// Dynamic Client Registration (MCP spec)
// ─────────────────────────────────────────────

app.post("/register", express.json(), (req, res) => {
  const body = req.body || {};
  res.status(201).json({
    client_id: body.client_id || crypto.randomUUID(),
    client_secret: body.client_secret || undefined,
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
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;

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
  const { grant_type, code, client_id, client_secret, redirect_uri, code_verifier, refresh_token } = req.body;

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
    const data = await zohoRes.json();
    res.status(zohoRes.status).json(data);
  } catch (err) {
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

app.post("/mcp", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="/.well-known/oauth-authorization-server"');
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
      sessionIdGenerator: undefined,   // ← stateless mode for serverless
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // Clean up after response is sent
    res.on("finish", () => {
      transport.close?.();
      mcpServer.close?.();
    });
  } catch (err) {
    console.error("POST /mcp error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/mcp", async (req, res) => {
  // In stateless mode, GET /mcp is not supported (no persistent SSE sessions)
  res.status(405).json({ error: "Method not allowed in stateless mode. Use POST /mcp." });
});

app.delete("/mcp", async (req, res) => {
  // Nothing to tear down in stateless mode
  res.status(204).end();
});

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
