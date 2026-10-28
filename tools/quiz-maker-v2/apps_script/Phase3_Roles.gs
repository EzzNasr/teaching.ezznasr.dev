// Phase 3 / S3 - Assistant role. Paste into Apps Script as its own file (any order).
// Contract: docs/followup-v3 plan, section 2.3.  Only declarations here - nothing runs at load time.
//
// An ASSISTANT is a normal student account whose Students-sheet `role` cell says "assistant".
//   - is_admin is NEVER touched: it stays blank, so every admin-only check keeps refusing them.
//   - The ONLY way in is Code.gs's _requireAdminSession (reached by _requireAdminAny), which calls
//     p3_assistantAllows() below. It lets a valid, non-stale assistant session through ONLY when
//     payload.action is in P3_STAFF_ALLOW. Everything else stays admin-only (deny by default).
//   - The ADMIN_TOKEN (desktop app) path is untouched: _requireAdmin is never consulted for roles.
//   - The role is re-read from the sheet on every call, so removing it takes effect on the next call.

// The actions an assistant may call. S3 owns this list; nobody else edits it.
var P3_STAFF_ALLOW = [
  "admin_followup_overview",
  "admin_followup_set_attendance",
  "admin_followup_save_group",
  "admin_followup_save_templates",
  "admin_student_summary",
  "admin_monthly_review",
  "admin_set_requirement",
  "admin_log_parent_notification",
  "admin_list_parent_notifications",
  "admin_grading_queue",
  "admin_grade_written",
  "admin_get_written_models",
  "get_written_image"
];

var P3_ROLE_ASSISTANT = "assistant";

function _p3IsStaffAction(action) {
  return typeof action === "string" && P3_STAFF_ALLOW.indexOf(action) !== -1;
}

// "admin" | "assistant" | "student" for one Students-sheet row. c = the _studentCols map.
// A sheet without a `role` column simply has no assistants.
function _p3RoleOfRow(row, c) {
  if (c.is_admin && _isTruthyFlag(row[c.is_admin - 1])) return "admin";
  if (c.role && String(row[c.role - 1] == null ? "" : row[c.role - 1]).trim().toLowerCase() === P3_ROLE_ASSISTANT) return "assistant";
  return "student";
}

// Called from _requireAdminSession AFTER the session token has matched. True only for a real
// assistant (never an admin - admins already passed) asking for an allow-listed action.
function p3_assistantAllows(row, c, payload) {
  return _p3RoleOfRow(row, c) === "assistant" && _p3IsStaffAction(payload && payload.action);
}

// "admin" | "assistant" | "student" | "none" | "stale". Never throws for a bad session.
function p3_session_role(payload) {
  if (!payload || !payload.student_id || !payload.session_token) return "none";
  var values = _students().getDataRange().getValues();
  var c = _studentCols(values[0]);
  var target = _normalizePhone(payload.student_id);
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][c.phone - 1], target)) {
      if (String(values[i][c.session_token - 1]) !== String(payload.session_token)) return "stale";
      return _p3RoleOfRow(values[i], c);
    }
  }
  return "none";
}

// Router action `p3_session_role`: the page asks "what am I?" so a cached session can't go stale.
function p3_action_session_role(payload) {
  return { ok: true, role: p3_session_role(payload) };
}

// Decorates a login / register / reset / profile reply with `role` (admin|assistant|student).
// Signature matches the router hook _p2Post(name, resp, payload). Never throws, never fails a login.
function p3_withRole(resp, payload) {
  try {
    if (!resp || resp.ok === false || !resp.student_id) return resp;
    var values = _students().getDataRange().getValues();
    var c = _studentCols(values[0]);
    var target = _normalizePhone(resp.student_id);
    for (var i = 1; i < values.length; i++) {
      if (_phonesMatch(values[i][c.phone - 1], target)) { resp.role = _p3RoleOfRow(values[i], c); return resp; }
    }
    resp.role = resp.is_admin ? "admin" : "student";
  } catch (err) {
    if (resp && typeof resp === "object") resp.role = resp.is_admin ? "admin" : "student";
  }
  return resp;
}

// Adds the `role` header if missing (same additive, self-healing pattern as session_token / is_admin).
// Returns the 1-based column number. Never touches existing rows.
function _p3EnsureRoleColumn(sheet) {
  var last = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, last).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === "role") return i + 1;
  }
  if (typeof sheet.getMaxColumns === "function" && last >= sheet.getMaxColumns()) sheet.insertColumnAfter(last);
  sheet.getRange(1, last + 1).setValue("role");
  return last + 1;
}

function _p3Who(payload) {
  return payload && payload.student_id ? String(payload.student_id) : "admin-token";
}

// admin_only. payload: {phone, role}  role: "assistant" | "" (or "student") to remove.
// The target must already be a student account. Admins can't be changed here, and "admin" can
// never be granted through the web: is_admin stays a by-hand flag in the Sheet.
function p3_admin_set_role(payload) {
  _requireAdminAny(payload);
  payload = payload || {};
  var phone = _normalizePhone(payload.phone);
  if (!phone) throw new Error("Missing phone number.");
  var role = String(payload.role == null ? "" : payload.role).trim().toLowerCase();
  if (role === "student") role = "";
  if (role === "admin") throw new Error("Admin can only be set by hand in the Students sheet.");
  if (role !== "" && role !== P3_ROLE_ASSISTANT) throw new Error("Unknown role.");
  var res = _withLock(function () {
    var sheet = _students();
    var roleCol = _p3EnsureRoleColumn(sheet);
    var found = _findStudentRow(sheet, phone);
    if (!found) throw new Error("No student account with that phone number.");
    if (found.is_admin) throw new Error("This account is an admin; its role can't be changed here.");
    var cur = sheet.getRange(found.row, roleCol, 1, 1).getValues()[0][0];
    var before = String(cur == null ? "" : cur).trim().toLowerCase();
    if (before !== P3_ROLE_ASSISTANT) before = "";
    sheet.getRange(found.row, roleCol).setValue(role);
    return {
      ok: true, phone: _restoreLeadingZero(String(found.phone)), name: String(found.display_name == null ? "" : found.display_name),
      role: role === "" ? "student" : role, changed: before !== role
    };
  });
  if (res.changed) p2_audit(_p3Who(payload), "p3_admin_set_role", res.phone, { role: res.role === "student" ? P3_ROLE_ASSISTANT : "" }, { role: res.role === "student" ? "" : res.role });
  return res;
}

// admin_only. Lists staff (admins read-only + assistants) and the allow-list the role grants.
function p3_admin_list_staff(payload) {
  _requireAdminAny(payload);
  var values = _students().getDataRange().getValues();
  var c = _studentCols(values[0]);
  var staff = [];
  for (var i = 1; i < values.length; i++) {
    var role = _p3RoleOfRow(values[i], c);
    if (role === "student") continue;
    staff.push({
      phone: _restoreLeadingZero(String(values[i][c.phone - 1])),
      name: String(values[i][c.display_name - 1] == null ? "" : values[i][c.display_name - 1]),
      role: role,
      year: c.year ? String(values[i][c.year - 1] || "") : ""
    });
  }
  return { ok: true, staff: staff, allow: P3_STAFF_ALLOW.slice() };
}
