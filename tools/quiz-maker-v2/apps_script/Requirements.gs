/* ==========================================================================
   Requirements.gs — Follow-up v2 / Session 4: the global requirements catalogue.

   WHAT IT DOES
   - A catalogue of requirements (watch, homework, quiz, attendance, written_answers + owner-made
     manual "custom_*" ones), each switchable and tunable once, globally.
   - Per-group overrides (inherit / on / off / custom).
   - Precedence for the "effective" set:  built-in default  <  global row  <  group override.
     The per-lesson LessonRequirements tab is a separate, LOWER level and is never read or changed here.
   - Five admin_req_* actions, an overview hook, and helpers other files read (req_effective_ ...).

   NEW SHEETS (in the DATA spreadsheet, like AuditLog; created on the first WRITE, never on a read)
     Requirements       key | label_ar | label_en | kind | scope | enabled | in_monthly_report | parent_message |
                        weight | rule_json | sort | edited | updated_at | updated_by
     GroupRequirements  group_key | req_key | mode | in_monthly_report | rule_json | note | updated_at | updated_by
     RequirementChecks  student_key | req_key | month | met | note | updated_at | updated_by
     MonthLessons       month | group_key | lessons_json | updated_at | updated_by          (Nov 2026, see below)
                        group_key "*" = the GENERAL list for that month; any other key = that group's own list,
                        which REPLACES the general one for that group. lessons_json = [{lesson, homework, quiz}].

   Until the owner edits anything the sheets may not exist, and every function answers from the built-in
   defaults below, which reproduce today's behaviour exactly.

   FILE RULES: this file defines only req_* / REQ_* names; it edits no existing sheet and no existing
   function. Routing and the assistant allow-list are Session 5's job (Code.gs + FollowupRouter.gs):
   they call req_routes_() and req_overviewHook_(). Written against the frozen contract (guide 3.3 to 3.5).
   The same rules exist client-side in assets/requirements-logic.js; tests/test_req_parity.js keeps them equal.
   ========================================================================== */

var REQ_BUILTIN_KEYS = ["watch", "homework", "quiz", "attendance", "written_answers"];
var REQ_MAX_CUSTOM = 30;
var REQ_MODES = ["inherit", "on", "off", "custom"];
var REQ_HEADERS = {
  Requirements: ["key", "label_ar", "label_en", "kind", "scope", "enabled", "in_monthly_report", "parent_message",
                 "weight", "rule_json", "sort", "edited", "updated_at", "updated_by"],
  GroupRequirements: ["group_key", "req_key", "mode", "in_monthly_report", "rule_json", "note", "updated_at", "updated_by"],
  RequirementChecks: ["student_key", "req_key", "month", "met", "note", "updated_at", "updated_by"],
  MonthLessons: ["month", "group_key", "lessons_json", "updated_at", "updated_by"]
};
// columns that must stay plain text (a month like 2026-11 or a phone key must not turn into a date / number)
var REQ_TEXT_COLS = {
  Requirements: ["key"], GroupRequirements: ["group_key", "req_key"], RequirementChecks: ["student_key", "req_key", "month"],
  MonthLessons: ["month", "group_key"]
};

function req_defaults_() {
  return [
    { key: "watch",           label_ar: "مشاهدة الفيديو",     label_en: "Watch video",     kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: true,  weight: 1, rule: { pct: 80 } },
    { key: "homework",        label_ar: "الواجب",              label_en: "Homework",        kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: true,  weight: 1, rule: {} },
    { key: "quiz",            label_ar: "الكويز",              label_en: "Quiz",            kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: true,  weight: 1, rule: {} },
    { key: "attendance",      label_ar: "الحضور",              label_en: "Attendance",      kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: false, weight: 1, rule: {} },
    { key: "written_answers", label_ar: "الإجابات المكتوبة",   label_en: "Written answers", kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: false, weight: 1, rule: {} }
  ];
}

// ---- small helpers -------------------------------------------------------------------------------
function req_clone_(o) { return JSON.parse(JSON.stringify(o)); }
function req_str_(v) {
  if (v === undefined || v === null) return "";
  if (v instanceof Date) return _cairoIso(v);
  return String(v);
}
function req_bool_(v, dflt) {
  if (v === true || v === false) return v;
  var s = req_str_(v).trim().toLowerCase();
  if (s === "") return dflt;
  return !(s === "false" || s === "0" || s === "no" || s === "off");
}
function req_isCustomKey_(key) { return /^custom_[a-z0-9_]{1,40}$/.test(String(key)); }
function req_isInt_(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n; }
function req_validWeight_(w) { return typeof w === "number" && isFinite(w) && w >= 0 && w <= 10; }
function req_parseJson_(s) { try { var v = JSON.parse(req_str_(s)); return v && typeof v === "object" ? v : null; } catch (e) { return null; } }
function req_now_() { return _cairoIso(new Date()); }

// {ok:true, rule} (cleaned) | {ok:false, error}
function req_validateRule_(key, rule) {
  if (rule === undefined || rule === null) rule = {};
  if (typeof rule !== "object" || Array.isArray(rule)) return { ok: false, error: "rule must be an object" };
  var out = {}, names = Object.keys(rule);
  var allowed = key === "watch" ? ["pct"] : key === "quiz" ? ["min_pct"] : [];
  for (var i = 0; i < names.length; i++) {
    if (allowed.indexOf(names[i]) < 0) return { ok: false, error: "Unknown rule field \"" + names[i] + "\" for " + key };
    var v = rule[names[i]];
    if (typeof v === "string" && /^\d+$/.test(v.trim())) v = parseInt(v, 10);
    if (!req_isInt_(v) || v < 1 || v > 100) return { ok: false, error: names[i] + " must be a whole number from 1 to 100" };
    out[names[i]] = v;
  }
  if (key === "watch" && out.pct === undefined) out.pct = 80;
  return { ok: true, rule: out };
}

// stored global rows (any subset) -> full catalogue (defaults fill the gaps). Mirrors RequirementsLogic.normalizeCatalog.
function req_normalizeCatalog_(rows) {
  var byKey = {};
  (rows || []).forEach(function (r) { if (r && r.key && !byKey.hasOwnProperty(r.key)) byKey[r.key] = r; });
  var out = req_defaults_().map(function (d) {
    var r = byKey[d.key], e = req_clone_(d);
    e.edited = false;
    if (r) {
      ["enabled", "in_monthly_report", "parent_message"].forEach(function (f) { if (typeof r[f] === "boolean") e[f] = r[f]; });
      if (req_validWeight_(r.weight)) e.weight = r.weight;
      if (r.label_ar) e.label_ar = String(r.label_ar);
      if (r.label_en) e.label_en = String(r.label_en);
      if (r.rule && typeof r.rule === "object") { var v = req_validateRule_(d.key, r.rule); if (v.ok) e.rule = v.rule; }
      e.edited = !!r.edited;
    }
    return e;
  });
  var customs = Object.keys(byKey).filter(function (k) { return req_isCustomKey_(k); }).map(function (k) { return byKey[k]; });
  customs.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
  customs.forEach(function (r) {
    out.push({ key: r.key, label_ar: String(r.label_ar || ""), label_en: String(r.label_en || ""), kind: "manual", scope: "per_month",
               enabled: r.enabled !== false, in_monthly_report: r.in_monthly_report !== false, parent_message: r.parent_message === true,
               weight: req_validWeight_(r.weight) ? r.weight : 1, rule: {}, edited: true });
  });
  return out;
}

// catalogue + one group's overrides {req_key:{mode,rule?,in_monthly_report?}} -> effective map. Mirrors RequirementsLogic.resolve.
function req_resolve_(catalog, groupOverrides) {
  var out = {};
  catalog.forEach(function (c) {
    var e = { enabled: c.enabled, in_monthly_report: c.in_monthly_report, parent_message: c.parent_message,
              rule: req_clone_(c.rule || {}), weight: c.weight, source: c.edited ? "global" : "default" };
    var o = groupOverrides && groupOverrides[c.key];
    if (o && o.mode === "off") { e.enabled = false; e.source = "group"; }
    else if (o && o.mode === "on") { e.enabled = true; e.source = "group"; }
    else if (o && o.mode === "custom") {
      e.enabled = true; e.source = "group";
      if (o.rule && typeof o.rule === "object") { var m = req_clone_(c.rule || {}); Object.keys(o.rule).forEach(function (k) { m[k] = o.rule[k]; }); e.rule = m; }
      if (typeof o.in_monthly_report === "boolean") e.in_monthly_report = o.in_monthly_report;
    }
    out[c.key] = e;
  });
  return out;
}

// ---- sheets ----------------------------------------------------------------------------------------
// Opens (creating on first use) one of the three tabs. WRITE paths only.
function req_sheet_(name) {
  var ss = _dataSs();
  var existed = !!ss.getSheetByName(name);
  var sh = _sheetByName(ss, name, REQ_HEADERS[name]);
  if (!existed) {
    var idx = _headerIndex(sh);
    REQ_TEXT_COLS[name].forEach(function (h) {
      try { sh.getRange(1, idx[h], Math.max(sh.getMaxRows(), 2), 1).setNumberFormat("@"); } catch (e) { /* cosmetic */ }
    });
  }
  return sh;
}

// All rows of a tab as objects ({_row, header: value ...}); [] when the tab does not exist. Never creates.
function req_rows_(name) {
  var sh = _dataSs().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getDataRange().getValues(), hd = vals[0], out = [];
  for (var i = 1; i < vals.length; i++) {
    var o = { _row: i + 1 };
    hd.forEach(function (h, j) { if (h !== "") o[h] = vals[i][j]; });
    out.push(o);
  }
  return out;
}

function req_rowArray_(name, rec) {
  return REQ_HEADERS[name].map(function (h) { return rec[h] === undefined || rec[h] === null ? "" : rec[h]; });
}
function req_writeRow_(sh, name, row, rec) {
  var arr = req_rowArray_(name, rec);
  if (row) sh.getRange(row, 1, 1, arr.length).setValues([arr]);
  else sh.appendRow(arr);
}

function req_globalRow_(r) {
  return {
    key: req_str_(r.key).trim(),
    label_ar: req_str_(r.label_ar), label_en: req_str_(r.label_en),
    enabled: req_bool_(r.enabled, true), in_monthly_report: req_bool_(r.in_monthly_report, true), parent_message: req_bool_(r.parent_message, false),
    weight: (r.weight === "" || r.weight === undefined || r.weight === null) ? 1 : Number(r.weight),
    rule: req_parseJson_(r.rule_json) || {}, sort: Number(r.sort) || 0, edited: req_bool_(r.edited, false)
  };
}

// {catalog, overrides} from the two tabs, one read each. overrides = {group_key: {req_key: {mode,rule?,in_monthly_report?,note,updated_at,by}}}
function req_load_() {
  var catalog = req_normalizeCatalog_(req_rows_("Requirements").map(req_globalRow_));
  var overrides = {};
  req_rows_("GroupRequirements").forEach(function (r) {
    var gk = _groupKey(r.group_key), rk = req_str_(r.req_key).trim(), mode = req_str_(r.mode).trim();
    if (!gk || !rk || REQ_MODES.indexOf(mode) < 0 || mode === "inherit") return;
    var o = { mode: mode, note: req_str_(r.note), updated_at: req_str_(r.updated_at), by: req_str_(r.updated_by) };
    var rule = req_parseJson_(r.rule_json); if (rule) o.rule = rule;
    var imr = req_str_(r.in_monthly_report).trim(); if (imr !== "") o.in_monthly_report = req_bool_(r.in_monthly_report, true);
    (overrides[gk] = overrides[gk] || {})[rk] = o;
  });
  return { catalog: catalog, overrides: overrides };
}

function req_knownGroups_() {   // {group_key: spelling} from the Groups tab (same source as the follow-up overview)
  try { return _groupSpellings(_ss().getSheetByName("Groups")); } catch (e) { return {}; }
}

// ---- public helpers other files read (contract 3.5) -------------------------------------------------
function req_catalog_() { return req_load_().catalog; }

function req_effective_(groupKey) {
  var L = req_load_(), gk = _groupKey(groupKey);
  return req_resolve_(L.catalog, gk ? L.overrides[gk] : null);
}

// {<custom key>: {met: true|false|null, note}} for every manual requirement; unchecked = {met:null,note:""}
function req_checks_for_(phoneKey, month) {
  var pk = _phoneKey(phoneKey), mo = req_str_(month).trim(), out = {};
  req_load_().catalog.forEach(function (c) { if (c.kind === "manual") out[c.key] = { met: null, note: "" }; });
  req_rows_("RequirementChecks").forEach(function (r) {
    if (req_str_(r.student_key).trim() !== pk || req_str_(r.month).trim() !== mo) return;
    var k = req_str_(r.req_key).trim();
    if (!out.hasOwnProperty(k)) return;
    var m = req_str_(r.met).trim();
    out[k] = { met: m === "" ? null : req_bool_(r.met, false), note: req_str_(r.note) };
  });
  return out;
}

// Overview hook (3.4): fills groups[].requirements and unclassified_requirements. Mutates in place.
function req_overviewHook_(overview) {
  if (!overview) return;
  var L = req_load_();
  (overview.groups || []).forEach(function (g) {
    g.requirements = req_resolve_(L.catalog, L.overrides[_groupKey(g.key || g.group)] || null);
  });
  overview.unclassified_requirements = req_resolve_(L.catalog, null);
}

// ---- who did it, audit -----------------------------------------------------------------------------
function req_caller_(payload) {
  if (payload.token) return { by: "token", role: "admin" };
  var f = null;
  try { f = _findStudentRow(_students(), payload.student_id); } catch (e) { f = null; }
  var name = f ? String(f.display_name == null ? "" : f.display_name).trim() : "";
  return { by: (name || String(payload.student_id || "")).replace(/[\[\]]/g, ""), role: f && f.is_admin ? "admin" : "assistant" };
}
function req_who_(caller) { return caller.by + " [" + caller.role + "]"; }
function req_audit_(caller, action, target, before, after) {
  try { p2_audit(req_who_(caller), action, target, before, after); } catch (e) { /* never breaks the action */ }
}

// short human sentence for the History tab, from an AuditLog row
function req_what_(action, target, beforeS, afterS) {
  var b = req_parseJson_(beforeS), a = req_parseJson_(afterS);
  var label = { req_save_global: "global", req_save_group: "group", req_check: "check", req_month_save: "month lessons" }[action] || action;
  if (action === "req_month_save") {   // "month lessons 2026-11|general: 2 -> 3 lessons"
    var cnt = function (o) { return o && Array.isArray(o.lessons) ? o.lessons.length + " lessons" : "none"; };
    return label + " " + target + ": " + (b ? cnt(b) + " -> " : "") + (a && a.lessons === null ? "removed" : cnt(a));
  }
  if (!a) return label + " " + target;
  if (!b) return label + " " + target + ": created " + req_brief_(a);
  var ch = [];
  Object.keys(a).forEach(function (k) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) ch.push(k + " " + JSON.stringify(b[k] === undefined ? null : b[k]) + " -> " + JSON.stringify(a[k]));
  });
  return label + " " + target + ": " + (ch.length ? ch.join(", ") : "no change");
}
function req_brief_(o) { return Object.keys(o).map(function (k) { return k + "=" + JSON.stringify(o[k]); }).join(", "); }

// ---- actions ----------------------------------------------------------------------------------------
// Every action: staff session check first, then work; errors come back as {ok:false,error}.
function req_wrap_(fn) {
  return function (payload) {
    try { payload = payload || {}; _requireAdminAny(payload); return fn(payload); }
    catch (e) { var r = { ok: false, error: e && e.message ? e.message : String(e) }; if (e && e.retryable) r.retryable = true; return r; }
  };
}

function req_fail_(msg) { throw new Error(msg); }

// admin_req_get {} -> {ok, catalog, groups, effective, unclassified, group_names}
//   optional request {month:"yyyy-MM"} adds checks:{<phoneKey>:{<custom key>:{met,note}}} for that month (extra field).
function req_actionGet_(payload) {
  var L = req_load_(), names = req_knownGroups_(), effective = {}, seen = {};
  Object.keys(names).concat(Object.keys(L.overrides)).forEach(function (gk) {
    if (seen[gk]) return; seen[gk] = true;
    effective[gk] = req_resolve_(L.catalog, L.overrides[gk] || null);
  });
  var out = { ok: true, catalog: L.catalog, groups: L.overrides, effective: effective,
              unclassified: req_resolve_(L.catalog, null), group_names: names };
  var mo = req_str_(payload.month).trim();
  if (mo) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mo)) req_fail_("month must be yyyy-MM");
    var manual = {}; L.catalog.forEach(function (c) { if (c.kind === "manual") manual[c.key] = true; });
    var checks = {};
    req_rows_("RequirementChecks").forEach(function (r) {
      if (req_str_(r.month).trim() !== mo) return;
      var k = req_str_(r.req_key).trim(), pk = req_str_(r.student_key).trim(), m = req_str_(r.met).trim();
      if (!manual[k] || !pk) return;
      (checks[pk] = checks[pk] || {})[k] = { met: m === "" ? null : req_bool_(r.met, false), note: req_str_(r.note) };
    });
    out.checks = checks; out.month = mo;
  }
  return out;
}

var REQ_PATCH_FIELDS = ["enabled", "in_monthly_report", "parent_message", "rule", "weight", "label_ar", "label_en", "kind"];

// admin_req_save_global {key, patch} -> {ok, requirement}
function req_actionSaveGlobal_(payload) {
  var caller = req_caller_(payload);
  var key = req_str_(payload.key).trim(), patch = payload.patch;
  if (!key) req_fail_("Missing requirement key.");
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) req_fail_("Nothing to change.");
  Object.keys(patch).forEach(function (f) { if (REQ_PATCH_FIELDS.indexOf(f) < 0) req_fail_("Unknown field \"" + f + "\"."); });
  var isBuiltin = REQ_BUILTIN_KEYS.indexOf(key) >= 0;
  if (!isBuiltin && !req_isCustomKey_(key)) req_fail_("Unknown requirement \"" + key + "\".");
  ["enabled", "in_monthly_report", "parent_message"].forEach(function (f) {
    if (patch[f] !== undefined && typeof patch[f] !== "boolean") req_fail_(f + " must be true or false.");
  });
  if (patch.weight !== undefined && !req_validWeight_(patch.weight)) req_fail_("weight must be a number from 0 to 10.");
  ["label_ar", "label_en"].forEach(function (f) {
    if (patch[f] !== undefined && (typeof patch[f] !== "string" || patch[f].length > 80)) req_fail_(f + " must be text up to 80 characters.");
  });

  var result = _withLock(function () {
    var sh = req_sheet_("Requirements");
    var rows = req_rows_("Requirements");
    if (!rows.length) {           // lazy seed: the five built-ins, unedited
      req_defaults_().forEach(function (d, i) {
        req_writeRow_(sh, "Requirements", 0, { key: d.key, label_ar: d.label_ar, label_en: d.label_en, kind: d.kind, scope: d.scope, enabled: true,
          in_monthly_report: true, parent_message: d.parent_message, weight: 1, rule_json: JSON.stringify(d.rule), sort: i + 1, edited: false });
      });
      rows = req_rows_("Requirements");
    }
    var existing = null;
    rows.forEach(function (r) { if (!existing && req_str_(r.key).trim() === key) existing = r; });
    var catalog = req_normalizeCatalog_(rows.map(req_globalRow_));
    var before = null, cur;
    catalog.forEach(function (c) { if (c.key === key) before = c; });

    if (!existing && !before) {   // brand-new custom requirement
      if (patch.kind !== "manual") req_fail_("A new requirement must have kind \"manual\".");
      var n = catalog.filter(function (c) { return c.kind === "manual"; }).length;
      if (n >= REQ_MAX_CUSTOM) req_fail_("At most " + REQ_MAX_CUSTOM + " custom requirements.");
      if (!String(patch.label_ar || "").trim() && !String(patch.label_en || "").trim()) req_fail_("A new requirement needs a label.");
      cur = { key: key, label_ar: String(patch.label_ar || "").trim(), label_en: String(patch.label_en || "").trim(), kind: "manual", scope: "per_month",
              enabled: patch.enabled !== false, in_monthly_report: patch.in_monthly_report !== false, parent_message: patch.parent_message === true,
              weight: patch.weight === undefined ? 1 : patch.weight, rule: {}, edited: true };
      if (patch.rule !== undefined) { var vr0 = req_validateRule_(key, patch.rule); if (!vr0.ok) req_fail_(vr0.error); }
      var maxSort = 0; rows.forEach(function (r) { maxSort = Math.max(maxSort, Number(r.sort) || 0); });
      req_writeRow_(sh, "Requirements", 0, { key: key, label_ar: cur.label_ar, label_en: cur.label_en, kind: "manual", scope: "per_month", enabled: cur.enabled,
        in_monthly_report: cur.in_monthly_report, parent_message: cur.parent_message, weight: cur.weight, rule_json: "{}", sort: maxSort + 1, edited: true,
        updated_at: req_now_(), updated_by: req_who_(caller) });
      req_audit_(caller, "req_save_global", key, "", cur);
      return cur;
    }

    if (patch.kind !== undefined && patch.kind !== before.kind) req_fail_("A requirement's kind cannot change.");
    cur = req_clone_(before);
    ["enabled", "in_monthly_report", "parent_message", "weight"].forEach(function (f) { if (patch[f] !== undefined) cur[f] = patch[f]; });
    ["label_ar", "label_en"].forEach(function (f) { if (patch[f] !== undefined) cur[f] = patch[f].trim(); });
    if (cur.kind === "manual" && !cur.label_ar && !cur.label_en) req_fail_("A requirement needs a label.");
    if (patch.rule !== undefined) {
      var vr = req_validateRule_(key, patch.rule);
      if (!vr.ok) req_fail_(vr.error);
      cur.rule = vr.rule;
    }
    var changed = ["enabled", "in_monthly_report", "parent_message", "weight", "label_ar", "label_en"].some(function (f) { return cur[f] !== before[f]; }) ||
                  JSON.stringify(cur.rule) !== JSON.stringify(before.rule);
    if (!changed) return before;
    cur.edited = true;
    var sort = existing ? existing.sort : "";
    var rec = { key: key, label_ar: cur.label_ar, label_en: cur.label_en, kind: cur.kind, scope: cur.scope, enabled: cur.enabled,
                in_monthly_report: cur.in_monthly_report, parent_message: cur.parent_message, weight: cur.weight, rule_json: JSON.stringify(cur.rule),
                sort: sort, edited: true, updated_at: req_now_(), updated_by: req_who_(caller) };
    if (existing) req_writeRow_(sh, "Requirements", existing._row, rec); else req_writeRow_(sh, "Requirements", 0, rec);
    req_audit_(caller, "req_save_global", key, req_pick_(before), req_pick_(cur));
    return cur;
  });
  return { ok: true, requirement: result };
}
function req_pick_(c) {
  return { enabled: c.enabled, in_monthly_report: c.in_monthly_report, parent_message: c.parent_message, weight: c.weight, rule: c.rule, label_ar: c.label_ar, label_en: c.label_en };
}

// admin_req_save_group {group, key, mode, patch?, note?} -> {ok, effective}
function req_actionSaveGroup_(payload) {
  var caller = req_caller_(payload);
  var gk = _groupKey(payload.group), key = req_str_(payload.key).trim(), mode = req_str_(payload.mode).trim();
  if (!gk) req_fail_("Missing group.");
  if (!key) req_fail_("Missing requirement key.");
  if (REQ_MODES.indexOf(mode) < 0) req_fail_("mode must be inherit, on, off or custom.");
  var patch = payload.patch;
  if (patch !== undefined && patch !== null) {
    if (typeof patch !== "object" || Array.isArray(patch)) req_fail_("patch must be an object.");
    Object.keys(patch).forEach(function (f) { if (f !== "rule" && f !== "in_monthly_report") req_fail_("Unknown patch field \"" + f + "\"."); });
    if (Object.keys(patch).length && mode !== "custom") req_fail_("patch is only used with mode \"custom\".");
    if (patch.in_monthly_report !== undefined && typeof patch.in_monthly_report !== "boolean") req_fail_("in_monthly_report must be true or false.");
  } else patch = {};
  var note = payload.note === undefined || payload.note === null ? "" : req_str_(payload.note).trim();
  if (note.length > 200) req_fail_("note is too long (200 characters).");
  if (!req_knownGroups_().hasOwnProperty(gk)) req_fail_("Unknown group.");

  var effective = _withLock(function () {
    var L = req_load_(), cat = null;
    L.catalog.forEach(function (c) { if (c.key === key) cat = c; });
    if (!cat) req_fail_("Unknown requirement \"" + key + "\".");
    var rule = null;
    if (mode === "custom") {
      if (patch.rule === undefined && patch.in_monthly_report === undefined) req_fail_("mode \"custom\" needs a rule or in_monthly_report.");
      if (patch.rule !== undefined) {
        var vr = req_validateRule_(key, patch.rule);
        if (!vr.ok) req_fail_(vr.error);
        if (key === "watch") vr.rule = { pct: vr.rule.pct };
        rule = vr.rule;
      }
    }
    var rows = req_rows_("GroupRequirements"), existing = null;
    rows.forEach(function (r) { if (!existing && _groupKey(r.group_key) === gk && req_str_(r.req_key).trim() === key) existing = r; });
    var beforeO = existing ? { mode: req_str_(existing.mode), rule: req_parseJson_(existing.rule_json), in_monthly_report: req_str_(existing.in_monthly_report) === "" ? null : req_bool_(existing.in_monthly_report, true), note: req_str_(existing.note) } : null;
    if (mode === "inherit") {
      if (existing) { _dataSs().getSheetByName("GroupRequirements").deleteRows(existing._row, 1); }
      if (existing) req_audit_(caller, "req_save_group", gk + "|" + key, beforeO, { mode: "inherit", rule: null, in_monthly_report: null, note: "" });
    } else {
      var sh = req_sheet_("GroupRequirements");
      var rec = { group_key: gk, req_key: key, mode: mode, in_monthly_report: patch.in_monthly_report === undefined ? "" : patch.in_monthly_report,
                  rule_json: rule ? JSON.stringify(rule) : "", note: note, updated_at: req_now_(), updated_by: req_who_(caller) };
      req_writeRow_(sh, "GroupRequirements", existing ? existing._row : 0, rec);
      var afterO = { mode: mode, rule: rule, in_monthly_report: patch.in_monthly_report === undefined ? null : patch.in_monthly_report, note: note };
      if (!beforeO || JSON.stringify(beforeO) !== JSON.stringify(afterO)) req_audit_(caller, "req_save_group", gk + "|" + key, beforeO || "", afterO);
    }
    var L2 = req_load_();
    return req_resolve_(L2.catalog, L2.overrides[gk] || null);
  });
  return { ok: true, effective: effective };
}

// admin_req_check {student, key, month, met, note?} -> {ok}
function req_actionCheck_(payload) {
  var caller = req_caller_(payload);
  var pk = _phoneKey(payload.student), key = req_str_(payload.key).trim(), month = req_str_(payload.month).trim();
  var met = payload.met;
  if (!pk) req_fail_("Missing student.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) req_fail_("month must be yyyy-MM.");
  if (met !== true && met !== false && met !== null) req_fail_("met must be true, false or null.");
  var note = payload.note === undefined || payload.note === null ? "" : req_str_(payload.note).trim();
  if (note.length > 200) req_fail_("note is too long (200 characters).");
  if (!_findStudentRow(_students(), payload.student)) req_fail_("Unknown student.");
  _withLock(function () {
    var cat = null;
    req_load_().catalog.forEach(function (c) { if (c.key === key) cat = c; });
    if (!cat) req_fail_("Unknown requirement \"" + key + "\".");
    if (cat.kind !== "manual") req_fail_("Only manual requirements are ticked by hand.");
    var rows = req_rows_("RequirementChecks"), existing = null;
    rows.forEach(function (r) { if (!existing && req_str_(r.student_key).trim() === pk && req_str_(r.req_key).trim() === key && req_str_(r.month).trim() === month) existing = r; });
    var beforeO = existing ? { met: req_str_(existing.met) === "" ? null : req_bool_(existing.met, false), note: req_str_(existing.note) } : null;
    var afterO = { met: met, note: note };
    if (met === null && note === "") {
      if (existing) { _dataSs().getSheetByName("RequirementChecks").deleteRows(existing._row, 1); req_audit_(caller, "req_check", pk + "|" + key + "|" + month, beforeO, afterO); }
      return;
    }
    var sh = req_sheet_("RequirementChecks");
    req_writeRow_(sh, "RequirementChecks", existing ? existing._row : 0,
      { student_key: pk, req_key: key, month: month, met: met === null ? "" : met, note: note, updated_at: req_now_(), updated_by: req_who_(caller) });
    if (!beforeO || JSON.stringify(beforeO) !== JSON.stringify(afterO)) req_audit_(caller, "req_check", pk + "|" + key + "|" + month, beforeO || "", afterO);
  });
  return { ok: true };
}

// admin_req_history {limit?<=50} -> {ok, items:[{at, by, role, what}]}  newest first, only this feature's rows
function req_actionHistory_(payload) {
  var limit = Number(payload.limit); if (!isFinite(limit) || limit < 1) limit = 30; limit = Math.min(Math.floor(limit), 50);
  var sh = _dataSs().getSheetByName("AuditLog"), items = [];
  if (sh && sh.getLastRow() >= 2) {
    var last = sh.getLastRow(), from = Math.max(2, last - 999);
    var vals = sh.getRange(from, 1, last - from + 1, 6).getValues();
    for (var i = vals.length - 1; i >= 0 && items.length < limit; i--) {
      var act = req_str_(vals[i][2]);
      if (act.indexOf("req_") !== 0) continue;
      var who = req_str_(vals[i][1]), m = /^(.*) \[(admin|assistant)\]$/.exec(who);
      items.push({ at: req_str_(vals[i][0]), by: m ? m[1] : who, role: m ? m[2] : "", what: req_what_(act, req_str_(vals[i][3]), vals[i][4], vals[i][5]) });
    }
  }
  return { ok: true, items: items };
}

// ---- lessons required in a month (Nov 2026) ----------------------------------------------------------
// The monthly report asks "which lessons should this student have done this month?". Before this, the answer was each
// group's weekly lists (review / homework / quiz lessons in GroupSettings). Now the owner can tick the lessons of a month:
// one GENERAL list for every group, and optionally a list for one group that REPLACES the general one for that group.
// Ticking a lesson makes its homework and its quiz required; each can be switched off on its own.
// Nothing chosen for a month = the old behaviour (weekly lists). Client copy: RequirementsLogic.*MonthLessons.
var REQ_MAX_MONTH_LESSONS = 60;
var REQ_MONTH_GENERAL = "*";
function req_isMonth_(m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(req_str_(m).trim()); }
function req_lessonPathKey_(raw) {
  return req_str_(raw).trim().toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}
// {ok:true, lessons} | {ok:false, error}. Mirrors RequirementsLogic.normalizeMonthLessons.
function req_month_normalize_(list) {
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list)) return { ok: false, error: "lessons must be a list" };
  var out = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (typeof it === "string") it = { lesson: it };
    if (!it || typeof it !== "object") return { ok: false, error: "lesson #" + (i + 1) + " is not valid" };
    var p = req_lessonPathKey_(it.lesson);
    if (!p || p.length > 200 || !/^[a-z0-9][a-z0-9._\/-]*$/.test(p)) return { ok: false, error: "lesson #" + (i + 1) + " has no valid lesson path" };
    if (it.homework !== undefined && typeof it.homework !== "boolean") return { ok: false, error: "homework must be true or false" };
    if (it.quiz !== undefined && typeof it.quiz !== "boolean") return { ok: false, error: "quiz must be true or false" };
    if (seen[p]) continue;
    seen[p] = true;
    out.push({ lesson: p, homework: it.homework !== false, quiz: it.quiz !== false });
  }
  if (out.length > REQ_MAX_MONTH_LESSONS) return { ok: false, error: "At most " + REQ_MAX_MONTH_LESSONS + " lessons in a month." };
  return { ok: true, lessons: out };
}
// plans (one month) {general:{lessons}|null, groups:{gk:{lessons}}} -> {source:"group"|"general"|"none", lessons}.
// Mirrors RequirementsLogic.resolveMonthLessons.
function req_month_resolve_(plans, group) {
  var gk = _groupKey(group), p = plans || {};
  var g = gk && p.groups && Object.prototype.hasOwnProperty.call(p.groups, gk) ? p.groups[gk] : null;
  if (g && Array.isArray(g.lessons)) return { source: "group", lessons: req_clone_(g.lessons) };
  if (p.general && Array.isArray(p.general.lessons)) return { source: "general", lessons: req_clone_(p.general.lessons) };
  return { source: "none", lessons: [] };
}
// Every month's lists, one read: {"2026-11": {general:{lessons,updated_at,by}|null, groups:{gk:{...}}}}. Never creates the tab.
function req_month_all_() {
  var out = {};
  req_rows_("MonthLessons").forEach(function (r) {
    var mo = req_str_(r.month).trim(), gk0 = req_str_(r.group_key).trim();
    if (!req_isMonth_(mo) || !gk0) return;
    var arr = null; try { arr = JSON.parse(req_str_(r.lessons_json) || "[]"); } catch (e) { arr = null; }
    var n = req_month_normalize_(arr);
    if (!n.ok) return;   // a hand-damaged cell: ignored (the month falls back), never a crash
    var rec = { lessons: n.lessons, updated_at: req_str_(r.updated_at), by: req_str_(r.updated_by) };
    var m = out[mo] = out[mo] || { general: null, groups: {} };
    if (gk0 === REQ_MONTH_GENERAL) { if (!m.general) m.general = rec; }
    else { var gk = _groupKey(gk0); if (gk && !m.groups.hasOwnProperty(gk)) m.groups[gk] = rec; }
  });
  return out;
}
function req_month_for_(month) { return req_month_all_()[req_str_(month).trim()] || { general: null, groups: {} }; }

// admin_req_month_get {month} -> {ok, month, general, groups, effective:{gk:{source, lessons}}, group_names}
function req_actionMonthGet_(payload) {
  var mo = req_str_(payload.month).trim();
  if (!req_isMonth_(mo)) req_fail_("month must be yyyy-MM.");
  var plans = req_month_for_(mo), names = req_knownGroups_(), effective = {};
  Object.keys(names).forEach(function (gk) { effective[gk] = req_month_resolve_(plans, gk); });
  return { ok: true, month: mo, general: plans.general, groups: plans.groups, effective: effective, group_names: names };
}

// admin_req_month_save {month, group?:"" = general, lessons:[{lesson, homework?, quiz?}]}  -> {ok, month, general, groups}
//                      {month, group?, clear:true}  removes that list (a group then follows the general list again)
function req_actionMonthSave_(payload) {
  var caller = req_caller_(payload);
  var mo = req_str_(payload.month).trim();
  if (!req_isMonth_(mo)) req_fail_("month must be yyyy-MM.");
  var rawGroup = req_str_(payload.group).trim(), gk = rawGroup ? _groupKey(rawGroup) : "";
  if (gk && !req_knownGroups_().hasOwnProperty(gk)) req_fail_("Unknown group.");
  var clear = payload.clear === true, lessons = null;
  if (!clear) {
    var n = req_month_normalize_(payload.lessons);
    if (!n.ok) req_fail_(n.error);
    lessons = n.lessons;
  }
  var cell = gk || REQ_MONTH_GENERAL, target = mo + "|" + (gk || "general");
  _withLock(function () {
    var existing = null;
    req_rows_("MonthLessons").forEach(function (r) {
      if (existing || req_str_(r.month).trim() !== mo) return;
      var g0 = req_str_(r.group_key).trim();
      if ((g0 === REQ_MONTH_GENERAL ? REQ_MONTH_GENERAL : _groupKey(g0)) === cell) existing = r;
    });
    var before = null;
    if (existing) { var b = null; try { b = JSON.parse(req_str_(existing.lessons_json) || "[]"); } catch (e) { b = null; } before = { lessons: b }; }
    if (clear) {
      if (existing) {
        _dataSs().getSheetByName("MonthLessons").deleteRows(existing._row, 1);
        req_audit_(caller, "req_month_save", target, before, { lessons: null });
      }
      return;
    }
    var sh = req_sheet_("MonthLessons");
    req_writeRow_(sh, "MonthLessons", existing ? existing._row : 0,
      { month: mo, group_key: cell, lessons_json: JSON.stringify(lessons), updated_at: req_now_(), updated_by: req_who_(caller) });
    if (!before || JSON.stringify(before.lessons) !== JSON.stringify(lessons)) req_audit_(caller, "req_month_save", target, before || "", { lessons: lessons });
  });
  var plans = req_month_for_(mo);
  return { ok: true, month: mo, general: plans.general, groups: plans.groups };
}

// {actionName: function(payload)} for Session 5's router (contract 3.5)
function req_routes_() {
  return {
    admin_req_get: req_wrap_(req_actionGet_),
    admin_req_save_global: req_wrap_(req_actionSaveGlobal_),
    admin_req_save_group: req_wrap_(req_actionSaveGroup_),
    admin_req_check: req_wrap_(req_actionCheck_),
    admin_req_history: req_wrap_(req_actionHistory_),
    admin_req_month_get: req_wrap_(req_actionMonthGet_),
    admin_req_month_save: req_wrap_(req_actionMonthSave_)
  };
}
