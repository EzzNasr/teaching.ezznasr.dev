// ============================================================================
// Phase4_Stats.gs  (P4 / S8)  Owner-only, read-only view of every teacher and subject.
//
// Contract: 00-MASTER-CONTRACT.md v2 section 6e. One router action: p4_admin_teacher_stats.
// Counts and sums only. No student name, phone, payment reference, note text or file id is ever
// copied into the response: phone / student_id columns are read only to count distinct people.
// Sheets are read in bulk (one column read per needed column), never one read per row.
// Depends on Code.gs helpers; S2 / S3 helpers are used only through typeof guards:
//   p4_ctx(payload), p4_subjectOf(x), p4_linked_(ctx)   (a missing one gives null, never a guess)
// Nothing runs at load time.
// ============================================================================

var P4S_SUBJECTS = ["programming", "english", "math"];
var P4S_CACHE_KEY = "p4stats:v1";
var P4S_CACHE_SECONDS = 300;
// Only the exact label Code.gs writes into Payments.note for chapter / term subscriptions
// ("Grade 1 · Chapter 3 · 250 EGP") counts as a price. Free text typed by a student never does.
var P4S_PRICE_RE = /^Grade \d+ · (?:Chapter|Term) \d+ · (\d+(?:\.\d+)?) ([A-Z]{3})$/;

// ---------------------------------------------------------------- helpers

function p4s_denied_() { return { ok: false, error: "Not authorized." }; }

function p4s_subject_(key) {
  try {
    if (typeof p4_subjectOf === "function") return String(p4_subjectOf(key) || "");
  } catch (e) { /* fall through */ }
  var s = String(key == null ? "" : key).split("#")[0].trim().toLowerCase();
  try { if (typeof p2k_canon === "function") s = String(p2k_canon(s)).toLowerCase(); } catch (e2) { /* keep s */ }
  var first = s.split("/")[0];
  return P4S_SUBJECTS.indexOf(first) === -1 ? "" : first;
}

function p4s_block_() {
  return {
    revenue: { all_time: {}, this_month: {}, last_month: {}, pending: {} },
    payments: { approved: 0, pending: 0, rejected: 0, unpriced: 0 },
    videos: 0,
    lessons: { total: 0, locked: 0 },
    quizzes: { locked: 0 },
    students: { linked: 0, active_30d: 0 },
    written: { awaiting: 0, oldest_days: null },
    quiz_results_30d: 0,
    groups: 0
  };
}

// Sums two blocks (or parts of them). null on either side stays null. oldest_days takes the maximum.
function p4s_merge_(a, b, key) {
  if (key === "oldest_days") { if (a === null || a === undefined) return b === undefined ? null : b; if (b === null || b === undefined) return a; }
  if (a === null || b === null) return null;
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (typeof a === "number" && typeof b === "number") return key === "oldest_days" ? Math.max(a, b) : a + b;
  if (typeof a === "object" && typeof b === "object") {
    var out = {};
    Object.keys(a).concat(Object.keys(b)).forEach(function (k) { if (!out.hasOwnProperty(k)) out[k] = p4s_merge_(a[k], b[k], k); });
    return out;
  }
  return a;
}
function p4s_clone_(o) { return JSON.parse(JSON.stringify(o)); }
function p4s_add_(map, cur, amt) { map[cur] = Math.round(((map[cur] || 0) + amt) * 100) / 100; }

function p4s_dayDiff_(laterYmd, earlierYmd) {
  var a = /^(\d{4})-(\d{2})-(\d{2})/.exec(laterYmd), b = /^(\d{4})-(\d{2})-(\d{2})/.exec(earlierYmd);
  if (!a || !b) return null;
  return Math.round((Date.UTC(+a[1], +a[2] - 1, +a[3]) - Date.UTC(+b[1], +b[2] - 1, +b[3])) / 86400000);
}

function p4s_prevMonth_(ym) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
  if (m < 1) { y--; m = 12; }
  return y + "-" + ("0" + m).slice(-2);
}

// {n, col:{name:[...]}} for a tab. A missing tab is "no rows" (zeros); a tab with a required column
// missing, or any read error, is null (the metrics that need it become null).
function p4s_read_(book, tab, required, optional) {
  try {
    var sh = book.getSheetByName(tab);
    return _readColumns(sh, required, optional || [], tab);
  } catch (e) {
    Logger.log("p4_admin_teacher_stats: could not read " + tab + ": " + (e && e.message));
    return null;
  }
}

function p4s_date_(v) { try { return String(_cairoDate(v) || ""); } catch (e) { return ""; } }
function p4s_pk_(v) { try { return _phoneKey(v); } catch (e) { return ""; } }

// ---------------------------------------------------------------- the action

// {refresh?: bool}
function p4_admin_teacher_stats(payload) {
  payload = payload || {};
  var ctx = null;
  try { ctx = typeof p4_ctx === "function" ? p4_ctx(payload) : null; } catch (e) { ctx = null; }
  if (!ctx || ctx.kind !== "owner") return p4s_denied_();

  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e0) { cache = null; }
  if (cache && payload.refresh !== true) {
    try {
      var hit = cache.get(P4S_CACHE_KEY);
      if (hit) { var o = JSON.parse(hit); o.cached = true; return o; }
    } catch (e1) { /* recompute */ }
  }
  var res = p4s_compute_();
  if (cache) { try { cache.put(P4S_CACHE_KEY, JSON.stringify(res), P4S_CACHE_SECONDS); } catch (e2) { /* too big or unavailable: fine */ } }
  return res;
}

function p4s_compute_() {
  var ss = _ss(), dataSs = _dataSs();
  var today = _todayCairo(), thisMonth = today.slice(0, 7), lastMonth = p4s_prevMonth_(thisMonth), since30 = _addDays(today, -30);

  // ---- one bulk read per sheet (null = unreadable)
  var S = {
    payments: p4s_read_(ss, "Payments", ["status", "scope"], ["note", "created_at", "decided_at", "phone"]),
    videos: p4s_read_(ss, "Videos", ["lesson", "embed_url"]),
    lessons: p4s_read_(ss, "Lessons", ["lesson", "locked"]),
    quizzes: p4s_read_(ss, "Quizzes", ["lesson", "locked"]),
    results: p4s_read_(dataSs, "QuizResults", ["student_id", "lesson"], ["date"]),
    subs: p4s_read_(dataSs, "Submissions", ["student_id", "lesson"], ["date"]),
    written: p4s_read_(dataSs, "WrittenAnswers", ["lesson", "awarded"], ["uploaded_at"]),
    ent: p4s_read_(ss, "Entitlements", ["phone", "scope"]),
    qa: p4s_read_(ss, "QuizAccess", ["phone", "lesson"]),
    groups: p4s_read_(ss, "Groups", ["group"]),
    owners: p4s_read_(ss, "GroupOwners", ["group", "owner_id"]),
    tg: p4s_read_(ss, "TeacherTelegram", ["teacher_id"])
  };
  var students = null;
  try { var sv = _students().getDataRange().getValues(); students = { values: sv, c: _studentCols(sv[0]) }; } catch (e) { students = null; }
  var lessonList = null;
  try { if (typeof _allLessonsFromGithub === "function") lessonList = _allLessonsFromGithub().lessons || []; } catch (e3) { lessonList = null; }

  var subjects = P4S_SUBJECTS.concat([""]);          // "" = rows whose subject is unknown (owner block only)
  var acc = {}; subjects.forEach(function (s) { acc[s] = p4s_block_(); });
  var people = {}, active = {};                      // subject -> {phoneKey: true}
  subjects.forEach(function (s) { people[s] = {}; active[s] = {}; });

  // ---- payments (subject = the payment row's own scope; amount = the system price label only)
  if (S.payments) {
    var P = S.payments.col;
    for (var i = 0; i < S.payments.n; i++) {
      var subj = p4s_subject_(P.scope[i]), b = acc[subj], st = String(P.status[i]).trim().toLowerCase();
      var m = P4S_PRICE_RE.exec(String(P.note[i] || "").trim());
      var amount = m ? parseFloat(m[1]) : null, cur = m ? m[2] : "";
      if (st === "approved") {
        b.payments.approved++;
        if (amount === null) b.payments.unpriced++;
        else {
          p4s_add_(b.revenue.all_time, cur, amount);
          var ym = (p4s_date_(P.decided_at[i]) || p4s_date_(P.created_at[i])).slice(0, 7);
          if (ym === thisMonth) p4s_add_(b.revenue.this_month, cur, amount);
          else if (ym === lastMonth) p4s_add_(b.revenue.last_month, cur, amount);
        }
        var pk = p4s_pk_(P.phone[i]); if (pk) people[subj][pk] = true;
      } else if (st === "pending") {
        b.payments.pending++;
        if (amount !== null) p4s_add_(b.revenue.pending, cur, amount);
        var pk2 = p4s_pk_(P.phone[i]); if (pk2) people[subj][pk2] = true;
      } else if (st === "rejected") b.payments.rejected++;
    }
  }
  // ---- videos, locks
  if (S.videos) for (var v = 0; v < S.videos.n; v++) if (String(S.videos.col.embed_url[v]).trim() !== "") acc[p4s_subject_(S.videos.col.lesson[v])].videos++;
  if (S.lessons) for (var l = 0; l < S.lessons.n; l++) if (_isLockedCell(S.lessons.col.locked[l]) && String(S.lessons.col.lesson[l]).trim() !== "") acc[p4s_subject_(S.lessons.col.lesson[l])].lessons.locked++;
  if (S.quizzes) for (var q = 0; q < S.quizzes.n; q++) if (_isLockedCell(S.quizzes.col.locked[q]) && String(S.quizzes.col.lesson[q]).trim() !== "") acc[p4s_subject_(S.quizzes.col.lesson[q])].quizzes.locked++;
  if (lessonList) lessonList.forEach(function (x) { acc[p4s_subject_(x.lesson)].lessons.total++; });

  // ---- quiz results / submissions: activity and linkage
  [["results", true], ["subs", false]].forEach(function (pair) {
    var src = S[pair[0]]; if (!src) return;
    for (var r = 0; r < src.n; r++) {
      var sj = p4s_subject_(src.col.lesson[r]), k = p4s_pk_(src.col.student_id[r]);
      if (k) people[sj][k] = true;
      var d = p4s_date_(src.col.date[r]), recent = d !== "" && d >= since30;
      if (recent && k) active[sj][k] = true;
      if (recent && pair[1]) acc[sj].quiz_results_30d++;
    }
  });
  if (S.ent) for (var e1 = 0; e1 < S.ent.n; e1++) { var k1 = p4s_pk_(S.ent.col.phone[e1]); if (k1) people[p4s_subject_(S.ent.col.scope[e1])][k1] = true; }
  if (S.qa) for (var e2 = 0; e2 < S.qa.n; e2++) { var k2 = p4s_pk_(S.qa.col.phone[e2]); if (k2) people[p4s_subject_(S.qa.col.lesson[e2])][k2] = true; }

  // ---- written answers waiting for a grade
  if (S.written) {
    for (var w = 0; w < S.written.n; w++) {
      if (String(S.written.col.awarded[w]).trim() !== "") continue;
      var wb = acc[p4s_subject_(S.written.col.lesson[w])];
      wb.written.awaiting++;
      var age = p4s_dayDiff_(today, p4s_date_(S.written.col.uploaded_at[w]));
      if (age !== null && age >= 0 && (wb.written.oldest_days === null || age > wb.written.oldest_days)) wb.written.oldest_days = age;
    }
  }

  // ---- null out what could not be read
  function nullIf(src, fn) { if (!src) subjects.forEach(function (s) { fn(acc[s]); }); }
  nullIf(S.payments, function (b) { b.revenue = null; b.payments = null; });
  nullIf(S.videos, function (b) { b.videos = null; });
  nullIf(S.lessons, function (b) { b.lessons.locked = null; });
  nullIf(S.quizzes, function (b) { b.quizzes.locked = null; });
  nullIf(S.results, function (b) { b.quiz_results_30d = null; });
  nullIf(S.written, function (b) { b.written = null; });
  if (!lessonList) subjects.forEach(function (s) { acc[s].lessons.total = null; });
  if (!S.results || !S.subs || !S.ent || !S.qa || !S.payments) subjects.forEach(function (s) { acc[s].students = null; });
  subjects.forEach(function (s) { acc[s].groups = null; });   // a group has no subject: only per teacher and for the owner

  // subject-level people counts
  if (S.results && S.subs && S.ent && S.qa && S.payments) {
    subjects.forEach(function (s) { acc[s].students = { linked: Object.keys(people[s]).length, active_30d: Object.keys(active[s]).length }; });
  }

  // ---- teachers
  var teachers = [], assistantsOf = {}, ownerRows = 0;
  var sc = students ? students.c : null;
  if (students && sc) {
    var V = students.values;
    var get = function (i, n) { return sc[n] ? V[i][sc[n] - 1] : ""; };
    var lc = function (x) { return String(x == null ? "" : x).trim().toLowerCase(); };
    for (var t = 1; t < V.length; t++) {
      var role = lc(get(t, "role"));
      if (role === "assistant" && String(get(t, "assistant_of")).trim() !== "") {
        var key = p4s_pk_(get(t, "assistant_of")); assistantsOf[key] = (assistantsOf[key] || 0) + 1;
      }
    }
    for (var t2 = 1; t2 < V.length; t2++) {
      if (lc(get(t2, "role")) !== "teacher" || (sc.is_admin && _isTruthyFlag(V[t2][sc.is_admin - 1]))) continue;
      var scope = lc(get(t2, "teacher_scope")).split(",").map(function (x) { return x.trim(); }).filter(function (x) { return P4S_SUBJECTS.indexOf(x) !== -1; });
      if (!scope.length) continue;
      teachers.push({ phone: _restoreLeadingZero(String(V[t2][sc.phone - 1])), name: String(get(t2, "display_name")), scope: scope });
    }
  }
  var coverage = {}; teachers.forEach(function (tc) { tc.scope.forEach(function (s) { coverage[s] = (coverage[s] || 0) + 1; }); });

  var ownerGroupsByTeacher = {};
  if (S.owners) for (var g = 0; g < S.owners.n; g++) {
    var ok = p4s_pk_(S.owners.col.owner_id[g]), gk = String(S.owners.col.group[g]).trim().toLowerCase();
    if (ok && gk) { (ownerGroupsByTeacher[ok] = ownerGroupsByTeacher[ok] || {})[gk] = true; }
  }
  var tgKeys = {};
  if (S.tg) for (var h = 0; h < S.tg.n; h++) { var tk = p4s_pk_(S.tg.col.teacher_id[h]); if (tk) tgKeys[tk] = true; }

  var tBlocks = teachers.map(function (tc) {
    var merged = null;
    tc.scope.forEach(function (s) { var c = p4s_clone_(acc[s]); merged = merged === null ? c : p4s_merge_(merged, c); });
    var tkey = p4s_pk_(tc.phone), block = { phone: tc.phone, name: tc.name, scope: tc.scope };
    Object.keys(merged).forEach(function (k) { block[k] = merged[k]; });
    // people-based metrics come from S3's linkage; without it they are null
    block.students = null;
    try {
      if (typeof p4_linked_ === "function") {
        var linked = p4_linked_({ kind: "teacher", via: "session", id: tc.phone, subjects: tc.scope, principal: tc.phone }) || [];
        var set = {}; linked.forEach(function (x) { var kk = p4s_pk_(x && typeof x === "object" ? (x.phone || x.student_id) : x); if (kk) set[kk] = true; });
        var act = {}; tc.scope.forEach(function (s) { Object.keys(active[s]).forEach(function (kk) { if (set[kk]) act[kk] = true; }); });
        block.students = (S.results && S.subs) ? { linked: Object.keys(set).length, active_30d: Object.keys(act).length } : null;
      }
    } catch (e4) { block.students = null; }
    block.groups = S.owners ? Object.keys(ownerGroupsByTeacher[tkey] || {}).length : null;
    block.assistants = students ? (assistantsOf[tkey] || 0) : null;
    block.telegram = !!tgKeys[tkey];
    if (tc.scope.some(function (s) { return coverage[s] > 1; })) block.shared_subject = true;
    return block;
  });

  // ---- owner (everything, unknown-subject rows included) and totals (sum of the three subjects)
  var owner = null, totals = null;
  subjects.forEach(function (s) { var c = p4s_clone_(acc[s]); owner = owner === null ? c : p4s_merge_(owner, c); });
  P4S_SUBJECTS.forEach(function (s) { var c = p4s_clone_(acc[s]); totals = totals === null ? c : p4s_merge_(totals, c); });
  var allPeople = {}, allActive = {};
  subjects.forEach(function (s) { Object.keys(people[s]).forEach(function (k) { allPeople[k] = true; }); Object.keys(active[s]).forEach(function (k) { allActive[k] = true; }); });
  owner.students = (S.results && S.subs && S.ent && S.qa && S.payments) ? { linked: Object.keys(allPeople).length, active_30d: Object.keys(allActive).length } : null;
  var allGroups = {};
  if (S.groups) { for (var gi = 0; gi < S.groups.n; gi++) { var gg = String(S.groups.col.group[gi]).trim().toLowerCase(); if (gg) allGroups[gg] = true; } owner.groups = Object.keys(allGroups).length; } else owner.groups = null;
  owner.assistants = students ? Object.keys(assistantsOf).reduce(function (n, k) { return n + assistantsOf[k]; }, 0) : null;
  totals.groups = null;
  if (owner.students) { totals.students = { linked: P4S_SUBJECTS.reduce(function (n, s) { return n + (acc[s].students ? acc[s].students.linked : 0); }, 0), active_30d: P4S_SUBJECTS.reduce(function (n, s) { return n + (acc[s].students ? acc[s].students.active_30d : 0); }, 0) }; }
  else totals.students = null;

  var subjectBlocks = P4S_SUBJECTS.map(function (s) {
    var b = p4s_clone_(acc[s]); var out = { subject: s };
    Object.keys(b).forEach(function (k) { out[k] = b[k]; });
    if (coverage[s] > 1) out.shared_subject = true;
    return out;
  });

  return {
    ok: true,
    generated_at: _cairoIso(new Date()),
    cached: false,
    currency_note: "Revenue counts only approved payments whose stored note carries a system price (chapter and term subscriptions, in the currency printed there). Per-lesson payments have no stored amount: they are counted under payments.unpriced and are NOT in revenue. Figures are per currency, never converted.",
    subjects: subjectBlocks,
    teachers: tBlocks,
    owner: owner,
    totals: totals
  };
}
