/**
 * Phase3_BulkAccess.gs  (Phase 3, session S4) — bulk lesson / quiz access.
 *
 * Paste next to Code.gs. Everything here is prefixed p3_ / _p3 / P3_ (frozen contract §2.3.6).
 * Router lines are NOT in this file; they are listed in HANDOFF-S4.md ("Shared-file edits"):
 *
 *   case "p3_admin_bulk_preview": return _json(p3_admin_bulk_preview(payload));
 *   case "p3_admin_bulk_grant":   return _json(p3_admin_bulk_grant(payload));
 *   case "p3_admin_bulk_revoke":  return _json(p3_admin_bulk_revoke(payload));
 *
 * Request shape (all three actions):
 *   { kind: "lesson" | "quiz",
 *     lessons: [scope|lesson path, ...],        // lesson kind: same scopes admin_grant_access takes ("*", "a/b/*", "a/b/lesson")
 *     groups:  [group name, ...],               // every current member is a target
 *     members: [phone, ...],                    // individual students (any phone spelling)
 *     expires_at? | days? | never?,             // grant only; same fields as the single grant
 *     mode?: "grant" | "revoke" }               // preview only (default "grant")
 *
 * Reply: { ok, applied, skipped, failed:[{target,lesson,error}], ... }.
 *
 * Rules are NOT re-implemented for grants: every write goes through the existing single-grant
 * internals _grantRaw (lessons) and _grantQuizRaw (quizzes), and group targets also call
 * _rememberGroupGrant so students added to the group later inherit the access, exactly like
 * admin_group_grant_access / admin_group_grant_quiz_access. The ONLY logic copied from Code.gs is the
 * revoke row-deletion (the single revoke handlers take the lock themselves, so they cannot be called
 * from inside our one lock) and the tiny "would this grant change anything" predictor used to skip no-ops.
 */

var P3_BULK_CAP = 400;   // max (distinct student x lesson) pairs per request

// ---- input ------------------------------------------------------------------------------------

function _p3bArr(v) {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

function _p3bKind(payload) {
  var k = String(payload.kind == null ? "" : payload.kind).trim().toLowerCase();
  if (k !== "lesson" && k !== "quiz") throw new Error('kind must be "lesson" or "quiz".');
  return k;
}

// Lessons -> canonical keys (deduped, order kept). Invalid input rejects the whole request: a typo
// should never silently shrink the batch.
function _p3bLessons(payload, kind) {
  var seen = {}, out = [];
  _p3bArr(payload.lessons).forEach(function (raw) {
    var s = kind === "quiz" ? _lessonPath(raw) : _normalizeScope(raw);
    if (!seen[s]) { seen[s] = 1; out.push(s); }
  });
  if (!out.length) throw new Error("Pick at least one " + (kind === "quiz" ? "quiz" : "lesson") + ".");
  return out;
}

// Term fields, exactly as the single grant reads them.
function _p3bTerm(payload) {
  var explicit = payload.expires_at ? _cleanYmd(payload.expires_at) : "";
  var days = explicit || payload.never === true ? 0 : _accessDays(payload);
  return { explicit: explicit, days: days };
}

// Resolve targets to distinct phones. Returns
//   { phones: [{phone, source, label}], groups: [{key, spelling, members:[phone]}], failed: [{target, lesson:"", error}] }
// A phone reached through a group AND listed in members is ONE target (source = first group, so the
// access stays tied to the group rule).
function _p3bTargets(ss, payload) {
  var failed = [], byPhone = {}, order = [], groups = [];
  var gnames = _p3bArr(payload.groups), mphones = _p3bArr(payload.members);
  if (!gnames.length && !mphones.length) throw new Error("Pick at least one group or student.");

  if (gnames.length) {
    var gsheet = ss.getSheetByName("Groups");
    var spellings = _groupSpellings(gsheet);
    var seenG = {};
    gnames.forEach(function (name) {
      var key = _groupKey(name);
      if (!key || seenG[key]) return;
      seenG[key] = 1;
      var members = _groupMembers(gsheet, key);
      if (!members.length) { failed.push({ target: String(name), lesson: "", error: "That group has no members yet." }); return; }
      var spelling = spellings[key] || String(name);
      var g = { key: key, spelling: spelling, members: [] };
      members.forEach(function (m) {
        var ph = _canonicalPhone(m.phone) || String(m.phone);
        g.members.push(ph);
        if (!byPhone[ph]) { byPhone[ph] = { phone: ph, source: "group:" + spelling, label: spelling }; order.push(ph); }
      });
      groups.push(g);
    });
  }
  var seenM = {};
  mphones.forEach(function (raw) {
    if (_normalizePhone(raw).length < 10) { failed.push({ target: String(raw), lesson: "", error: "Enter the student's full phone number." }); return; }
    var ph = _canonicalPhone(raw);
    if (seenM[ph]) return;
    seenM[ph] = 1;
    if (!byPhone[ph]) { byPhone[ph] = { phone: ph, source: "manual", label: ph }; order.push(ph); }
  });
  return { phones: order.map(function (p) { return byPhone[p]; }), groups: groups, failed: failed };
}

function _p3bCapCheck(nPhones, nLessons) {
  var pairs = nPhones * nLessons;
  if (pairs > P3_BULK_CAP) {
    throw new Error("Too many changes in one go (" + pairs + " = " + nPhones + " students × " + nLessons +
      " items; the limit is " + P3_BULK_CAP + "). Split it into smaller batches.");
  }
  return pairs;
}

// ---- reading current state (one pass per sheet) -------------------------------------------------

// Index of existing rows: list of {phone, key, ymd, row} for Entitlements (scope) or QuizAccess (lesson).
function _p3bIndex(ss, kind) {
  var name = kind === "quiz" ? "QuizAccess" : "Entitlements";
  var keyCol = kind === "quiz" ? "lesson" : "scope";
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var c = _needCols(sheet, name, ["phone", keyCol, "expires_at"]);
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    out.push({ phone: values[i][c.phone - 1], key: _canonKey(String(values[i][c[keyCol] - 1]).trim().toLowerCase()),
               ymd: _ymdOf(values[i][c.expires_at - 1], tz), row: i + 2 });
  }
  return out;
}

function _p3bFind(index, phone, key) {
  for (var i = 0; i < index.length; i++) if (index[i].key === key && _phonesMatch(index[i].phone, phone)) return index[i];
  return null;
}

// Mirrors the expiry arithmetic at the top of _grantRaw/_grantQuizRaw, ONLY to decide "would this change anything?".
// The real write is always done by those functions.
function _p3bTarget(found, explicit, days) {
  var today = _todayCairo();
  var existing = found ? found.ymd : null;
  var target;
  if (explicit) target = explicit;
  else if (days) target = _addDays(existing && existing > today ? existing : today, days);
  else target = "";
  if (found && existing === "") target = "";
  else if (found && existing && target !== "" && existing > target) target = existing;
  return target;
}

// ---- preview ------------------------------------------------------------------------------------

function _p3bBuildPlan(ss, payload, mode) {
  var kind = _p3bKind(payload);
  var lessons = _p3bLessons(payload, kind);
  var term = mode === "revoke" ? { explicit: "", days: 0 } : _p3bTerm(payload);
  var tg = _p3bTargets(ss, payload);
  var pairs = _p3bCapCheck(tg.phones.length, lessons.length);
  var index = _p3bIndex(ss, kind);
  var items = [];
  tg.phones.forEach(function (p) {
    lessons.forEach(function (l) {
      var found = _p3bFind(index, p.phone, l);
      var change, expires = "";
      if (mode === "revoke") {
        change = found ? "revoke" : "skip";
        expires = found ? found.ymd : "";
      } else {
        var target = _p3bTarget(found, term.explicit, term.days);
        if (found && found.ymd === target) change = "skip";
        else change = found ? "extend" : "create";
        expires = target;
      }
      items.push({ phone: p.phone, lesson: l, change: change, expires_at: expires, source: p.source });
    });
  });
  return { kind: kind, lessons: lessons, term: term, targets: tg, pairs: pairs, items: items };
}

function _p3bCounts(items) {
  var n = { create: 0, extend: 0, revoke: 0, skip: 0 };
  items.forEach(function (i) { n[i.change]++; });
  return n;
}

// Read-only. Tells the UI exactly what apply would do.
function p3_admin_bulk_preview(payload) {
  _requireAdminAny(payload);
  var mode = String(payload.mode || "grant").toLowerCase() === "revoke" ? "revoke" : "grant";
  var plan = _p3bBuildPlan(_ss(), payload, mode);
  var n = _p3bCounts(plan.items);
  return { ok: true, mode: mode, kind: plan.kind, lessons: plan.lessons.length, students: plan.targets.phones.length,
           total: plan.items.length, would_apply: n.create + n.extend + n.revoke, would_create: n.create, would_extend: n.extend,
           would_revoke: n.revoke, would_skip: n.skip, failed: plan.targets.failed, cap: P3_BULK_CAP };
}

// ---- grant --------------------------------------------------------------------------------------

function p3_admin_bulk_grant(payload) {
  _requireAdminAny(payload);
  var res = _withLock(function () {
    var ss = _ss();
    var plan = _p3bBuildPlan(ss, payload, "grant");
    var failed = plan.targets.failed.slice();
    var applied = 0, skipped = 0, created = 0, extended = 0;
    var sourceOf = {};
    plan.targets.phones.forEach(function (p) { sourceOf[p.phone] = p.source; });

    plan.items.forEach(function (it) {
      if (it.change === "skip") { skipped++; return; }
      try {
        if (plan.kind === "quiz") _grantQuizRaw(ss, it.phone, it.lesson, plan.term.explicit, plan.term.days, sourceOf[it.phone]);
        else _grantRaw(ss, it.phone, it.lesson, plan.term.explicit, plan.term.days, sourceOf[it.phone]);
        applied++;
        if (it.change === "create") created++; else extended++;
      } catch (e) {
        failed.push({ target: it.phone, lesson: it.lesson, error: String(e && e.message || e) });
      }
    });

    // Remember group rules (so later joiners inherit the access) — same call the group handlers make.
    var rules = 0;
    plan.targets.groups.forEach(function (g) {
      plan.lessons.forEach(function (l) {
        try {
          _rememberGroupGrant(ss, g.key, g.spelling, plan.kind === "quiz" ? "quiz" : "access", l, plan.term.explicit, plan.term.days);
          rules++;
        } catch (e) {
          failed.push({ target: g.spelling, lesson: l, error: "Group rule not saved: " + String(e && e.message || e) });
        }
      });
    });
    return { ok: true, kind: plan.kind, applied: applied, created: created, extended: extended, skipped: skipped,
             failed: failed, group_rules: rules, students: plan.targets.phones.length, lessons: plan.lessons.length,
             groups: plan.targets.groups.map(function (g) { return g.spelling; }) };
  });
  _p3bAudit(payload, "p3_admin_bulk_grant", res);
  return res;
}

// ---- revoke -------------------------------------------------------------------------------------

// INSIDE the lock. Deletes the matching rows for (phone, key); returns the removed rows' details
// {removed, expires_at, pays}. Lesson kind also reports the payments behind them, so the caller can mark them revoked
// (same bookkeeping as handleAdminRevokeAccess).
function _p3bRevokeOne(ss, kind, phone, key) {
  var name = kind === "quiz" ? "QuizAccess" : "Entitlements";
  var keyCol = kind === "quiz" ? "lesson" : "scope";
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return { removed: 0, expires_at: "", pays: [] };
  var c = _needCols(sheet, name, ["phone", keyCol, "expires_at"]);
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var srcCol = kind === "quiz" ? 0 : (_headerIndex(sheet)["source"] || 0);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var rows = [], pays = [], ymd = "";
  for (var i = 0; i < values.length; i++) {
    if (!_phonesMatch(values[i][c.phone - 1], phone)) continue;
    if (_canonKey(String(values[i][c[keyCol] - 1]).trim().toLowerCase()) !== key) continue;
    rows.push(i + 2);
    ymd = _ymdOf(values[i][c.expires_at - 1], tz) || "";
    var src = srcCol ? _sourcePayment(values[i][srcCol - 1]) : "";
    if (src) pays.push(src);
  }
  rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRows(r, 1); });
  return { removed: rows.length, expires_at: ymd, pays: pays };
}

function _p3bMarkPaymentsRevoked(ss, pays) {
  var marked = [];
  var pSheet = pays.length ? ss.getSheetByName("Payments") : null;
  if (!pSheet || pSheet.getLastRow() < 2) return marked;
  var pc = _needCols(pSheet, "Payments", ["payment_id", "status", "decided_at"]);
  var pv = pSheet.getRange(2, 1, pSheet.getLastRow() - 1, pSheet.getLastColumn()).getValues();
  var now = _fmt(new Date(), TZ, true);
  for (var k = 0; k < pv.length; k++) {
    var id = String(pv[k][pc.payment_id - 1]).trim();
    if (pays.indexOf(id) === -1 || String(pv[k][pc.status - 1]).trim().toLowerCase() !== "approved") continue;
    pSheet.getRange(k + 2, pc.status).setNumberFormat("@").setValue("revoked");
    pSheet.getRange(k + 2, pc.decided_at).setNumberFormat("@").setValue(now);
    marked.push(id);
  }
  return marked;
}

function p3_admin_bulk_revoke(payload) {
  _requireAdminAny(payload);
  var res = _withLock(function () {
    var ss = _ss();
    var plan = _p3bBuildPlan(ss, payload, "revoke");
    var failed = plan.targets.failed.slice();
    var applied = 0, skipped = 0, allPays = [];
    var revoked = [];   // for the undo hint: what to re-grant

    plan.items.forEach(function (it) {
      if (it.change === "skip") { skipped++; return; }
      try {
        var r = _p3bRevokeOne(ss, plan.kind, it.phone, it.lesson);
        if (!r.removed) { skipped++; return; }
        applied++;
        allPays = allPays.concat(r.pays);
        revoked.push({ phone: it.phone, lesson: it.lesson, expires_at: r.expires_at });
      } catch (e) {
        failed.push({ target: it.phone, lesson: it.lesson, error: String(e && e.message || e) });
      }
    });
    var paymentsRevoked = [];
    try { paymentsRevoked = _p3bMarkPaymentsRevoked(ss, allPays); }
    catch (e) { failed.push({ target: "payments", lesson: "", error: "Payment rows not marked revoked: " + String(e && e.message || e) }); }

    // A group target also drops the group's standing rule for that item, like the group revoke handlers.
    var rules = 0;
    plan.targets.groups.forEach(function (g) {
      plan.lessons.forEach(function (l) {
        try { rules += _forgetGroupGrants(ss, g.key, plan.kind === "quiz" ? "quiz" : "access", l) > 0 ? 1 : 0; }
        catch (e) { failed.push({ target: g.spelling, lesson: l, error: "Group rule not removed: " + String(e && e.message || e) }); }
      });
    });
    return { ok: true, kind: plan.kind, applied: applied, skipped: skipped, failed: failed, revoked: revoked,
             payments_revoked: paymentsRevoked, group_rules_removed: rules,
             students: plan.targets.phones.length, lessons: plan.lessons.length };
  });
  _p3bAudit(payload, "p3_admin_bulk_revoke", res);
  return res;
}

// ---- audit --------------------------------------------------------------------------------------

function _p3bAudit(payload, action, res) {
  try {
    var who = payload.student_id && !payload.token ? payload.student_id : "token";
    var target = _p3bArr(payload.groups).concat(_p3bArr(payload.members)).join(",").slice(0, 200);
    p2_audit(who, action, target, "", {
      kind: res.kind, lessons: _p3bArr(payload.lessons).slice(0, 50), applied: res.applied, skipped: res.skipped,
      failed: (res.failed || []).length, never: payload.never === true, expires: payload.expires_at || "", days: payload.days || ""
    });
  } catch (e) { /* logging must never fail the action */ }
}
