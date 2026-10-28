// Phase3_Flags.gs  (Session S1, Phase 3)
// Makes the Phase 2 feature switches visible and one-click fixable. Nothing here changes a flag's name or meaning
// (contract: Follow-up V3 section 2.3-1). Flags are Script Properties; "1" or "true" = on, anything else = off.
//
//   p3_setup_enable_followup_flags()   run ONCE from the Apps Script editor: turns the five flags on, logs before/after.
//   p3_flag_status()                   read-only: what each flag is right now (also logged).
//   p3_admin_flag_status(payload)      same, as an admin-only action (router line goes in HANDOFF-S1.md).
//
// FF_CAMERA note: docs/rollout-checklist.md holds it back until a low-end Android and iOS Safari test passes. Turning it on
// here is the owner's decision; the log line below repeats the reminder.

var P3_FOLLOWUP_FLAGS = ["FF_PARENT_LOG", "FF_MONTHLY", "FF_DEFERRED_ANSWERS", "FF_CAMERA", "FF_GRADING"];

function _p3FlagOn(raw) { return raw === "1" || String(raw).toLowerCase() === "true"; }

function _p3FlagSnapshot() {
  var props = PropertiesService.getScriptProperties(), out = {};
  P3_FOLLOWUP_FLAGS.forEach(function (n) {
    var raw = props.getProperty(n);
    out[n] = { raw: raw === null || raw === undefined ? null : String(raw), on: _p3FlagOn(raw) };
  });
  return out;
}

function p3_flag_status() {
  var snap = _p3FlagSnapshot();
  P3_FOLLOWUP_FLAGS.forEach(function (n) { Logger.log(n + " = " + (snap[n].raw === null ? "(not set)" : snap[n].raw) + "  ->  " + (snap[n].on ? "ON" : "OFF")); });
  return { ok: true, flags: snap };
}

function p3_admin_flag_status(payload) {
  _requireAdminAny(payload);
  return p3_flag_status();
}

function p3_setup_enable_followup_flags() {
  var before = _p3FlagSnapshot(), props = PropertiesService.getScriptProperties(), changed = [];
  P3_FOLLOWUP_FLAGS.forEach(function (n) {
    if (!before[n].on) { props.setProperty(n, "1"); changed.push(n); }
  });
  var after = _p3FlagSnapshot();
  Logger.log("BEFORE: " + JSON.stringify(before));
  Logger.log("AFTER:  " + JSON.stringify(after));
  Logger.log(changed.length ? "Turned ON: " + changed.join(", ") : "Nothing to change: all five flags were already on.");
  if (changed.indexOf("FF_CAMERA") >= 0) Logger.log("Reminder: FF_CAMERA was held back on purpose (docs/rollout-checklist.md: test on a low-end Android and iOS Safari).");
  var audited = false;
  if (typeof p2_audit === "function") audited = p2_audit("editor", "p3_enable_followup_flags", "script-properties", before, after) === true;
  return { ok: true, changed: changed, before: before, after: after, audited: audited };
}
