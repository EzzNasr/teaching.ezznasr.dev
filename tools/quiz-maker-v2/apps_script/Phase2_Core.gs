// Phase 2 core helpers (owned by Session 5). Paste into Apps Script as its own file.
// Contract: docs/contract.md. Only declarations here - nothing runs at load time.

// Router hook: doPost's Phase 2 `case` lines call this with the handler's name.
function _p2Call(handlerName, payload) {
  var fn = (typeof globalThis !== "undefined" ? globalThis : this)[handlerName];
  if (typeof fn !== "function") {
    return { ok: false, error: "Not implemented yet: " + handlerName.replace(/^p2_/, ""), not_implemented: true };
  }
  return fn(payload);
}

// Like _p2Call, but when the Phase 2 handler is not pasted yet the OLD handler answers, so an
// action that worked before Phase 2 (the two follow-up actions) never regresses to "not implemented".
function _p2CallOr(handlerName, fallback, payload) {
  var fn = (typeof globalThis !== "undefined" ? globalThis : this)[handlerName];
  return typeof fn === "function" ? fn(payload) : fallback(payload);
}

// Feature flags are Script Properties (FF_CAMERA, FF_DEFERRED_ANSWERS, FF_GRADING,
// FF_PARENT_LOG, FF_MONTHLY). "1" or "true" means on; anything else, or missing, is off.
function p2_flag(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  return v === "1" || String(v).toLowerCase() === "true";
}

// Throws a marked error when the flag is off. The router turns it into
// {ok:false, error:"Feature disabled: FF_X", disabled:true}.
function p2_requireFlag(name) {
  if (!p2_flag(name)) {
    var e = new Error("Feature disabled: " + name);
    e.disabled = true;
    throw e;
  }
}

var P2_AUDIT_HEADERS = ["at", "who", "action", "target", "before", "after"];

// Appends one audit row. Never throws (a logging problem must not fail the real action).
function p2_audit(who, action, target, before, after) {
  try {
    var ss = _dataSs();
    var sh = ss.getSheetByName("AuditLog");
    if (!sh) {
      sh = ss.insertSheet("AuditLog");
      sh.appendRow(P2_AUDIT_HEADERS);
    }
    var s = function (v) { return v === undefined || v === null ? "" : (typeof v === "string" ? v : JSON.stringify(v)); };
    sh.appendRow([_cairoIso(new Date()), s(who), s(action), s(target), s(before), s(after)]);
    return true;
  } catch (err) {
    return false;
  }
}

// Optional S3 hooks around two existing actions: when Phase2_Capture.gs is not pasted they are no-ops.
function _p2Pre(name, payload) { var f = (typeof globalThis !== "undefined" ? globalThis : this)[name]; return typeof f === "function" ? f(payload) : payload; }
function _p2Post(name, resp, payload) { var f = (typeof globalThis !== "undefined" ? globalThis : this)[name]; return typeof f === "function" ? f(resp, payload) : resp; }


// Audit coverage (R-022): every access-changing admin action leaves one AuditLog row (contract section 8).
// Wraps the response only: never changes it, never throws. Failed actions (ok:false) are not logged.
function _p2AuditWrap(action, payload, resp) {
  try {
    if (resp && resp.ok !== false) {
      var p = payload || {};
      var target = p.phone || p.student || p.group || p.lesson || p.scope || "";
      var detail = { scope: p.scope || p.lesson || p.slot || "", group: p.group || "", never: p.never === true, expires: p.expires_at || p.expires || "", locked: p.locked };
      p2_audit(p.student_id && !p.token ? p.student_id : "token", action, target, "", detail);
    }
  } catch (e) { /* logging must never fail the action */ }
  return resp;
}
