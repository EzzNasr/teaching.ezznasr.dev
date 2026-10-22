/**
 * Phase2_Keys.gs  (S1)  — paste into Apps Script as its own file, next to Code.gs.
 *
 * admin_migrate_lesson_keys
 *   Rewrites old/typo'd lesson keys (see LESSON_ALIASES in Code.gs) to the current ones in the
 *   access tabs. DRY RUN BY DEFAULT: nothing changes unless the request has  apply: true.
 *   Safe to run twice (second run finds nothing). QuizResults / Submissions are never touched:
 *   they keep their history under the old bare slug and are matched through the alias map.
 *
 *   Before changing a tab it copies it to "bak_<Tab>_<yyyymmdd>_<n>".
 *   A Lessons / Videos / Quizzes row whose current key already has a row is NOT renamed (that
 *   would create a duplicate); it is listed under "conflicts" for you to resolve by hand.
 *
 *   Request:  { action: "admin_migrate_lesson_keys", token | session, apply?: true }
 *   Reply:    { ok, dry_run, changes: [{tab, column, row, from, to}], conflicts: [...],
 *               tabs_changed: [...], backups: [...] }
 */

var MIGRATE_TARGETS = [
  { tab: "Entitlements", column: "scope" },
  { tab: "QuizAccess", column: "lesson" },
  { tab: "Attendance", column: "lesson" },
  { tab: "WatchProgress", column: "lesson" },
  { tab: "Lessons", column: "lesson", unique: true },
  { tab: "Videos", column: "lesson", unique: true, alsoKey: "slot" },
  { tab: "Quizzes", column: "lesson", unique: true },
  { tab: "GroupSettings", column: "current_lesson" },
  { tab: "GroupSettings", column: "review_lessons", json: true },
  { tab: "GroupSettings", column: "hw_lessons", json: true },
  { tab: "GroupSettings", column: "quiz_lessons", json: true }
];

function handleAdminMigrateLessonKeys(payload) {
  _requireAdminAny(payload);
  var apply = payload.apply === true;
  return _withLock(function () {
    var ss = _ss();
    var changes = [], conflicts = [], plans = {};   // plans[tab] = [{col, row, to}]

    MIGRATE_TARGETS.forEach(function (t) {
      var sheet = ss.getSheetByName(t.tab);
      if (!sheet || sheet.getLastRow() < 2) return;
      var idx = _headerIndex(sheet);
      if (!idx[t.column]) return;
      var n = sheet.getLastRow() - 1;
      var col = sheet.getRange(2, idx[t.column], n, 1).getValues().map(function (r) { return r[0]; });
      var keyCol = t.alsoKey && idx[t.alsoKey]
        ? sheet.getRange(2, idx[t.alsoKey], n, 1).getValues().map(function (r) { return String(r[0]).trim().toLowerCase(); })
        : null;

      // rows already holding a current key (for the duplicate check)
      var have = {};
      if (t.unique) col.forEach(function (v, i) {
        have[String(v).trim().toLowerCase() + "|" + (keyCol ? keyCol[i] : "")] = true;
      });

      col.forEach(function (raw, i) {
        var from = String(raw == null ? "" : raw), to;
        if (t.json) {
          var arr; try { arr = JSON.parse(from || "[]"); } catch (e) { return; }
          if (!Array.isArray(arr)) return;
          var seen = {}, out = [], moved = false;
          arr.forEach(function (x) {
            var c = _canonKey(String(x).trim().toLowerCase());
            if (c !== String(x).trim().toLowerCase()) moved = true;
            if (!seen[c]) { seen[c] = 1; out.push(c); }
          });
          if (!moved) return;
          to = JSON.stringify(out);
        } else {
          var low = from.trim().toLowerCase();
          to = _canonKey(low);
          if (to === low) return;
          if (t.unique && have[to + "|" + (keyCol ? keyCol[i] : "")]) {
            conflicts.push({ tab: t.tab, column: t.column, row: i + 2, from: from, to: to,
                             why: "a row for the current key already exists" });
            return;
          }
        }
        changes.push({ tab: t.tab, column: t.column, row: i + 2, from: from, to: to });
        (plans[t.tab] = plans[t.tab] || []).push({ col: idx[t.column], row: i + 2, to: to });
      });
    });

    var backups = [], tabsChanged = Object.keys(plans);
    if (apply && tabsChanged.length) {
      var stamp = _todayCairo().replace(/-/g, "") + "_" + (Date.now() % 100000);
      tabsChanged.forEach(function (tab) {
        var src = ss.getSheetByName(tab);
        var bak = ss.insertSheet("bak_" + tab + "_" + stamp);
        var vals = src.getDataRange().getValues();
        bak.getRange(1, 1, vals.length, vals[0].length).setValues(vals);
        backups.push(bak.getName());
      });
      tabsChanged.forEach(function (tab) {
        var sheet = ss.getSheetByName(tab);
        plans[tab].forEach(function (p) { sheet.getRange(p.row, p.col).setValue(p.to); });
      });
    }
    return { ok: true, dry_run: !apply, changes: changes, conflicts: conflicts,
             tabs_changed: apply ? tabsChanged : [], backups: backups };
  });
}


// =====================================================================================
// Integration glue (S5, Oct 21): the contract surface from docs/contract.md section 2 and 4.
// S1 built the resolver inside Code.gs (_canonKey / LESSON_ALIASES). The contract wants it here
// too, with no load-order dependence, so this is a literal MIRROR of that map. tests R-001b and
// test_keys.js fail if the three copies (this, Code.gs, assets/lesson-aliases.json) differ.
// =====================================================================================
var P2_LESSON_ALIASES = {
  "programming/baccalaureate/grade-2-secondary/lesson-1-development-of-information-technology-and-social-transformation": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-1-development-of-information-technology-and-social-transformation",
  "programming/baccalaureate/grade-2-secondary/lesson-2-how-ai-works": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-2-how-ai-works",
  "programming/baccalaureate/grade-2-secondary/chaper-1-lesson-3-ai-in-daily-life-and-industry": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-3-ai-in-daily-life-and-industry",
  "lesson-1-development-of-information-technology-and-social-transformation": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-1-development-of-information-technology-and-social-transformation",
  "lesson-2-how-ai-works": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-2-how-ai-works",
  "chaper-1-lesson-3-ai-in-daily-life-and-industry": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-3-ai-in-daily-life-and-industry"
};

// Canonical full key for a full key or bare slug in the alias map; anything else comes back unchanged.
function p2k_canon(key) {
  var s = key == null ? "" : String(key);
  return Object.prototype.hasOwnProperty.call(P2_LESSON_ALIASES, s) ? P2_LESSON_ALIASES[s] : s;
}
// Every spelling that means this lesson, canonical first.
function p2k_aliases(key) {
  var c = p2k_canon(key), out = [c];
  Object.keys(P2_LESSON_ALIASES).forEach(function (a) { if (P2_LESSON_ALIASES[a] === c && out.indexOf(a) === -1) out.push(a); });
  return out;
}
function p2k_same(a, b) { return p2k_canon(a) === p2k_canon(b); }

// Contract wrapper: {dry_run?:true} (default true; dry_run:false applies). S1's native {apply:true} still works.
// Adds the contract field names next to S1's, and writes one AuditLog row per applied run.
function p2_admin_migrate_lesson_keys(payload) {
  payload = payload || {};
  var apply = payload.dry_run === false || payload.apply === true;
  var res = handleAdminMigrateLessonKeys(Object.assign({}, payload, { apply: apply }));
  (res.changes || []).forEach(function (c) { c.field = c.column; c.before = c.from; c.after = c.to; });
  res.backup_tab = (res.backups && res.backups[0]) || "";
  if (apply && res.changes && res.changes.length) {
    p2_audit(payload.student_id || "token", "migrate_lesson_keys", { tabs: res.tabs_changed },
             { changes: res.changes.length }, { backups: res.backups });
  }
  return res;
}
