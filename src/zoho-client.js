/**
 * Zoho People API Client
 * Accepts a per-request Bearer token from Claude's OAuth flow.
 */

const ZOHO_PEOPLE_URLS = {
  com: "https://people.zoho.com",
  eu: "https://people.zoho.eu",
  in: "https://people.zoho.in",
  "com.au": "https://people.zoho.com.au",
  jp: "https://people.zoho.jp",
};

export class ZohoClient {
  constructor(domain = "com") {
    this.domain = domain;
    this.baseUrl = ZOHO_PEOPLE_URLS[domain] || ZOHO_PEOPLE_URLS.com;
    this.apiBase = `${this.baseUrl}/people/api`;
    this._accessToken = null;
  }

  set accessToken(token) {
    this._accessToken = token;
  }

  async request(endpoint, options = {}) {
    if (!this._accessToken) throw new Error("No access token — re-authenticate.");

    const url = endpoint.startsWith("http") ? endpoint : `${this.apiBase}${endpoint}`;
    const { method = "GET", params = {}, body = null } = options;

    let fullUrl = url;
    if (method === "GET" && Object.keys(params).length > 0) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") sp.append(k, v);
      }
      fullUrl = `${url}?${sp.toString()}`;
    }

    const headers = { Authorization: `Zoho-oauthtoken ${this._accessToken}` };
    const fetchOpts = { method, headers };

    if (body && method !== "GET") {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null)
          form.append(k, typeof v === "object" ? JSON.stringify(v) : v);
      }
      fetchOpts.body = form.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const res = await fetch(fullUrl, fetchOpts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text, status: res.status }; }

    const errObj = data?.response?.errors || (data?.errorCode ? { code: data.errorCode, message: data.message } : null);
    if (errObj) {
      const code = errObj.code;
      const msg = errObj.message || JSON.stringify(errObj);
      // Multiple separate log lines so each fits in Vercel log viewer.
      console.error(`ZOHO_ERR_CODE: ${code}`);
      console.error(`ZOHO_ERR_MSG: ${msg}`);
      console.error(`ZOHO_REQ_URL: ${fullUrl}`);
      console.error(`ZOHO_RAW: ${text}`);
      throw new Error(
        `Zoho API error ${code}: ${msg}. URL: ${fullUrl}. Raw: ${text.slice(0, 800)}`
      );
    }
    console.log(`ZOHO_OK: ${fullUrl} status=${res.status}`);
    return data;
  }

  // ── EMPLOYEES ──
  _emp(id) { return id.includes("@") ? { emailId: id } : { empId: id }; }
  getEmployees(i = 1, l = 200) { return this.request("/forms/employee/getRecords", { params: { sIndex: `${i}`, limit: `${l}` } }); }
  getEmployeeById(id) { return this.request("/forms/employee/getDataByID", { params: { recordId: id } }); }
  searchEmployees(col, val) { return this.request("/forms/employee/getRecords", { params: { searchColumn: col, searchValue: val } }); }
  createEmployee(data) { return this.request("/forms/employee/insertRecord", { method: "POST", body: { inputData: data } }); }
  updateEmployee(id, data) { return this.request("/forms/employee/updateRecord", { method: "POST", body: { recordId: id, inputData: data } }); }

  // ── ATTENDANCE ──
  checkIn(empId, time) { const p = { ...this._emp(empId), dateFormat: "yyyy-MM-dd HH:mm:ss" }; if (time) p.checkIn = time; return this.request("/attendance", { method: "POST", body: p }); }
  checkOut(empId, time) { const p = { ...this._emp(empId), dateFormat: "yyyy-MM-dd HH:mm:ss" }; if (time) p.checkOut = time; return this.request("/attendance", { method: "POST", body: p }); }
  getAttendance(empId, sd, ed) { return this.request("/attendance/getUserReport", { params: { ...this._emp(empId), sdate: sd, edate: ed, dateFormat: "yyyy-MM-dd" } }); }
  getAttendanceEntries(empId, sd, ed) { return this.request("/attendance/getAttendanceEntries", { params: { ...this._emp(empId), sdate: sd, edate: ed, dateFormat: "yyyy-MM-dd" } }); }
  bulkImportAttendance(data) { return this.request("/attendance/bulkImport", { method: "POST", body: { data } }); }

  // ── SHIFTS ──
  getShiftConfiguration(empId, sd, ed) { return this.request("/attendance/getShiftConfiguration", { params: { ...this._emp(empId), sdate: sd, edate: ed, dateFormat: "yyyy-MM-dd" } }); }
  updateUserShift(empId, shift, fd, td) { return this.request("/attendance/updateUserShift", { method: "POST", body: { ...this._emp(empId), shiftName: shift, fdate: fd, tdate: td, dateFormat: "yyyy-MM-dd" } }); }

  // ── LEAVE ──
  getLeaveTypes(uid) { return this.request("/leave/getLeaveTypeDetails", { params: { userId: uid } }); }
  getLeaveRecords(uid, sd, ed) { const p = {}; if (uid) p.userId = uid; if (sd) p.sdate = sd; if (ed) p.edate = ed; return this.request("/forms/leave/getRecords", { params: p }); }
  applyLeave(data) { return this.request("/forms/leave/insertRecord", { method: "POST", body: { inputData: data } }); }
  getLeaveBalance(uid) { const p = {}; if (uid) p.userId = uid; return this.request("/v2/leavetracker/reports/bookedAndBalance", { params: p }); }
  getLeaveUserReport(uid) { const p = {}; if (uid) p.userId = uid; return this.request("/v2/leavetracker/reports/user", { params: p }); }

  // ── DEPARTMENTS ──
  getDepartments(i = 1, l = 200) { return this.request("/forms/department/getRecords", { params: { sIndex: `${i}`, limit: `${l}` } }); }
  createDepartment(data) { return this.request("/forms/department/insertRecord", { method: "POST", body: { inputData: data } }); }

  // ── DESIGNATIONS ──
  getDesignations(i = 1, l = 200) { return this.request("/forms/designation/getRecords", { params: { sIndex: `${i}`, limit: `${l}` } }); }

  // ── TIMESHEETS ──
  getTimesheets(empId, sd, ed) { const p = {}; if (empId) p.empId = empId; if (sd) p.sdate = sd; if (ed) p.edate = ed; return this.request("/timetracker/gettimesheet", { params: p }); }
  addTimeLog(empId, projId, jobId, date, hrs, desc) { const b = { empId, projectId: projId, jobId, workDate: date, hours: `${hrs}`, dateFormat: "yyyy-MM-dd" }; if (desc) b.description = desc; return this.request("/timetracker/addtimelog", { method: "POST", body: b }); }
  getTimesheetProjects() { return this.request("/timetracker/getprojects"); }
  getTimesheetJobs() { return this.request("/timetracker/getjobs"); }

  // ── PERFORMANCE MANAGEMENT ──
  // Goals
  getGoals(i = 1, l = 200) { return this.request("/forms/goal/getRecords", { params: { sIndex: `${i}`, limit: `${l}` } }); }
  getGoalById(id) { return this.request("/forms/goal/getDataByID", { params: { recordId: id } }); }
  createGoal(data) { return this.request("/forms/goal/insertRecord", { method: "POST", body: { inputData: data } }); }
  updateGoal(id, data) { return this.request("/forms/goal/updateRecord", { method: "POST", body: { recordId: id, inputData: data } }); }
  // KRAs (Key Result Areas)
  getKRAs(i = 1, l = 200) { return this.request("/forms/kra/getRecords", { params: { sIndex: `${i}`, limit: `${l}` } }); }
  getKRAById(id) { return this.request("/forms/kra/getDataByID", { params: { recordId: id } }); }
  // Skillsets / Competencies
  getSkillsets(i = 1, l = 200) { return this.request("/forms/skillset/getRecords", { params: { sIndex: `${i}`, limit: `${l}` } }); }
  // Reviews / Appraisals
  getReviews(i = 1, l = 200) { return this.request("/forms/review/getRecords", { params: { sIndex: `${i}`, limit: `${l}` } }); }
  getReviewById(id) { return this.request("/forms/review/getDataByID", { params: { recordId: id } }); }
  // Feedback
  getFeedback(i = 1, l = 200) { return this.request("/forms/feedback/getRecords", { params: { sIndex: `${i}`, limit: `${l}` } }); }
  submitFeedback(data) { return this.request("/forms/feedback/insertRecord", { method: "POST", body: { inputData: data } }); }
  // Performance records by employee — uses the generic forms search
  getPerformanceByEmployee(formLinkName, empId) {
    return this.request(`/forms/${formLinkName}/getRecords`, {
      params: { searchColumn: "Employee_ID", searchValue: empId },
    });
  }
}
