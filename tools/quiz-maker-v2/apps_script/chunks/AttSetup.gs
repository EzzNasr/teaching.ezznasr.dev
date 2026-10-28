/* AttSetup.gs — Session 1. Creates the 7 attendance tabs (idempotent) and ATT_MASTER_SECRET.
 * Run att_setup() once from the Apps Script editor.
 * Standalone (non-container-bound) project? Run att_setup("<spreadsheetId>") once; it is stored as ATT_SHEET_ID.
 */
var ATT_HEADERS = {
  AttStudents: ["student_id", "name", "device_id", "created_at", "status"],
  AttDevices: ["device_id", "student_id", "secret_hash", "fp_hash", "bound_at", "status"],
  AttRequests: ["req_id", "student_id", "new_device_id", "new_secret_hash", "new_fp_hash", "fp_match", "status", "created_at", "decided_at"],
  AttRooms: ["room_id", "name", "lat", "lng", "samples", "calibrated_at"],
  AttSessions: ["session_id", "course", "room_id", "start_utc", "close_utc", "status", "hall_lat", "hall_lng"],
  AttCheckins: ["checkin_id", "session_id", "student_id", "device_id", "server_utc", "lat", "lng", "acc", "dist_m", "fp_hash", "flags", "status"],
  AttFlagLog: ["ts_utc", "session_id", "student_id", "code", "detail"],
};

function att_setup(sheetId) {
  var props = PropertiesService.getScriptProperties();
  if (sheetId) props.setProperty("ATT_SHEET_ID", String(sheetId));
  var ss = att_ss_();
  var report = [];
  Object.keys(ATT_HEADERS).forEach(function (name) {
    var h = ATT_HEADERS[name];
    var sh = ss.getSheetByName(name);
    var created = false;
    if (!sh) { sh = ss.insertSheet(name); created = true; }
    var cur = sh.getLastRow() >= 1 ? sh.getRange(1, 1, 1, Math.max(h.length, sh.getLastColumn())).getValues()[0] : [];
    var empty = cur.every(function (v) { return v === "" || v == null; });
    var same = h.every(function (x, i) { return cur[i] === x; });
    if (empty) {
      sh.getRange(1, 1, 1, h.length).setValues([h]);
    } else if (!same) {
      throw new Error("Tab " + name + " exists with different headers; fix or rename it manually (not overwritten).");
    }
    // Plain-text columns: keeps ISO timestamps and IDs with leading zeros exactly as written.
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), h.length).setNumberFormat("@");
    sh.setFrozenRows(1);
    report.push(name + (created ? " (created)" : " (ok)"));
  });
  var secretMade = false;
  if (!props.getProperty("ATT_MASTER_SECRET")) {
    // 2 UUIDv4 (CSPRNG-backed) -> 64 hex chars
    var s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    props.setProperty("ATT_MASTER_SECRET", s);
    secretMade = true;
  }
  var adminOk = !!props.getProperty("ADMIN_TOKEN") || typeof ADMIN_TOKEN !== "undefined";
  Logger.log("att_setup: " + report.join(", ") + " | ATT_MASTER_SECRET " + (secretMade ? "created" : "already set") +
    " | ADMIN_TOKEN " + (adminOk ? "found" : "NOT FOUND (admin actions will fail)"));
  return { ok: true, tabs: report, secret_created: secretMade, admin_token_found: adminOk };
}
