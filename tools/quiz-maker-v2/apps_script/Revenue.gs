/* ==========================================================================
   Revenue.gs — the owner's revenue page (dashboard/teacher-stats.html, «الإيرادات»). Nov 2026.

   WHAT COUNTS AS REVENUE (the owner's rule)
   - Only money paid THROUGH THE WEBSITE: a row in the Payments tab (a student pressed "I paid" and typed the
     transfer reference) whose status is "approved". Access given by hand, by a group grant or for center
     attendance never makes a Payments row, so it is never counted.
   - Pending rows are shown apart ("waiting for you"). Rejected / revoked rows are never counted.

   HOW MUCH A PAYMENT IS WORTH (first match wins)
   1. the "amount" column of the Payments row (EGP). New lesson payments get it written when the student
      presses "I paid" (rev_stampLessonPrice_, called from handleRequestAccess in Code.gs). The owner may
      also type an amount there by hand.
   2. the price inside a subscription note that Code.gs writes ("Grade 1 · Chapter 3 · 250 EGP").
   3. otherwise the row has no amount ("unpriced"). Old lesson payments can be filled in ONCE at today's
      lesson price with admin_revenue_fill_old (option C, agreed with the owner 2026-11-13).

   THE LESSON PRICE lives in the Script Property REV_LESSON_PRICE_EGP and is set from the page
   (admin_revenue_set_price). Unset = new lesson payments get no amount.

   ACTIONS (all owner only; routed from Code.gs):
     admin_revenue_report     {}                 -> totals + rows [{month, kind, item, group, amount, count}]
     admin_revenue_set_price  {price}            -> {price}
     admin_revenue_fill_old   {dry_run?}         -> {fillable | filled, price}
   The report holds counts and sums only: no student name, phone or payment reference.
     teacher_revenue_report   {}                 -> the TEACHER's read-only page (dashboard/my-revenue.html, Phase 2.5 F):
                                                    cards, courses > lessons (price, videos, visible), every purchase in
                                                    HIS subjects (student name, item, method, date; never a phone or a
                                                    payment reference). The owner may call it too and gets every subject.
                                                    Assistants and students: never.

   FILE RULES: defines only rev_* / REV_* names plus the four handlers; reads the Payments and Groups tabs (and, for
   teacher_revenue_report, Videos, Lessons and QuizContent), writes only the Payments "amount" column (created on the
   first write) and one Script Property.
   ========================================================================== */

var REV_PRICE_PROP = "REV_LESSON_PRICE_EGP";
var REV_AMOUNT_COL = "amount";
var REV_SUB_PRICE_RE = /^Grade (\d+) · (Chapter|Term) (\d+) · (\d+(?:\.\d+)?) EGP$/;
var REV_MAX_PRICE = 100000;

function rev_denied_() { return { ok: false, error: "Not authorized." }; }

function rev_isOwner_(payload) {
  try { var ctx = typeof p4_ctx === "function" ? p4_ctx(payload || {}) : null; return !!ctx && ctx.kind === "owner"; }
  catch (e) { return false; }
}

// The lesson price in EGP, or null when it is not set (or not a sensible number).
function rev_lessonPrice_() {
  var raw = String(_props().getProperty(REV_PRICE_PROP) || "").trim();
  if (!raw) return null;
  var n = Number(raw);
  return isFinite(n) && n > 0 && n <= REV_MAX_PRICE ? n : null;
}

// A sheet cell (Date or text) -> "yyyy-MM", or "".
function rev_ym_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, TZ, "yyyy-MM");
  var m = /^(\d{4})-(\d{2})/.exec(String(v == null ? "" : v).trim());
  return m ? m[1] + "-" + m[2] : "";
}

// A positive number from an amount cell ("250", 250, "250 EGP"), else null.
function rev_num_(v) {
  if (typeof v === "number") return isFinite(v) && v > 0 ? v : null;
  var m = /^\s*(\d+(?:\.\d+)?)\s*(?:EGP|جنيه|ج)?\s*$/i.exec(String(v == null ? "" : v));
  return m && +m[1] > 0 ? +m[1] : null;
}

// What was bought: {kind: "lesson"|"chapter"|"term", item: key the page can label}.
// Subscription scopes look like "programming/baccalaureate/grade-1-secondary#ch3" / "#t1".
function rev_item_(scope) {
  var s = String(scope == null ? "" : scope).trim().toLowerCase();
  var h = s.indexOf("#");
  if (h === -1) {
    try { if (typeof _canonKey === "function") s = _canonKey(s); } catch (e) { /* keep s */ }
    return { kind: "lesson", item: s };
  }
  var tag = s.slice(h + 1), g = /grade-(\d+)/.exec(s.slice(0, h));
  var m = /^(ch|t)(\d+)$/.exec(tag);
  if (!m) return { kind: "other", item: s };
  return { kind: m[1] === "ch" ? "chapter" : "term", item: "g" + (g ? g[1] : "?") + "-" + m[1] + m[2] };
}

function rev_phoneKey_(p) {
  var s = "";
  try { s = typeof _canonicalPhone === "function" ? String(_canonicalPhone(p) || "") : ""; } catch (e) { s = ""; }
  s = (s || String(p == null ? "" : p)).replace(/\D/g, "");
  return s.slice(-10);
}

// phone key -> the student's group name (the first group they are in, as the Groups tab is today).
function rev_groupsByPhone_(ss) {
  var out = {};
  var sh = ss.getSheetByName("Groups");
  if (!sh || sh.getLastRow() < 2) return out;
  var v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var gi = v[0].indexOf("group"), pi = v[0].indexOf("phone");
  if (gi === -1 || pi === -1) return out;
  for (var i = 1; i < v.length; i++) {
    var k = rev_phoneKey_(v[i][pi]), g = String(v[i][gi] || "").trim();
    if (k && g && !out[k]) out[k] = g;
  }
  return out;
}

// The Payments tab as {sheet, values, col: name -> 0-based index}, or null when there is none.
function rev_payments_(ss) {
  var sh = ss.getSheetByName("Payments");
  if (!sh || sh.getLastRow() < 1) return null;
  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var col = {};
  values[0].forEach(function (h, i) { h = String(h || "").trim(); if (h && !(h in col)) col[h] = i; });
  return { sheet: sh, values: values, col: col };
}

function rev_cell_(P, r, name) { return name in P.col ? P.values[r][P.col[name]] : ""; }

// The amount of one Payments row, or null.
function rev_amountOf_(P, r) {
  var a = rev_num_(rev_cell_(P, r, REV_AMOUNT_COL));
  if (a !== null) return a;
  var m = REV_SUB_PRICE_RE.exec(String(rev_cell_(P, r, "note") || "").trim());
  return m ? +m[4] : null;
}

// Called by handleRequestAccess (Code.gs) right after it appends a lesson payment row: writes today's
// lesson price into that row's amount column. Best effort: a failure never blocks the student's request.
function rev_stampLessonPrice_(sheet, paymentId) {
  try {
    var price = rev_lessonPrice_();
    if (price === null || !sheet) return false;
    var amountCol = rev_ensureAmountCol_(sheet);
    var head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var idCol = head.indexOf("payment_id") + 1;
    if (!idCol) return false;
    var last = sheet.getLastRow();
    if (last < 2) return false;
    var ids = sheet.getRange(2, idCol, last - 1, 1).getValues();   // one read; the new row is near the end
    for (var i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]).trim() === String(paymentId)) {
        sheet.getRange(i + 2, amountCol).setValue(price);
        return true;
      }
    }
  } catch (e) { try { Logger.log("rev_stampLessonPrice_: " + (e && e.message)); } catch (e2) { /* ignore */ } }
  return false;
}

// 1-based column of "amount", added at the end of the header row when missing.
function rev_ensureAmountCol_(sheet) {
  var head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var i = head.indexOf(REV_AMOUNT_COL);
  if (i !== -1) return i + 1;
  var c = sheet.getLastColumn() + 1;
  sheet.getRange(1, c).setValue(REV_AMOUNT_COL);
  return c;
}

/* ---------------------------------------------------------------- actions */

function admin_revenue_report(payload) {
  if (!rev_isOwner_(payload)) return rev_denied_();
  var ss = _ss();
  var today = _todayCairo(), thisMonth = today.slice(0, 7);
  var lastMonth = (function () { var y = +thisMonth.slice(0, 4), m = +thisMonth.slice(5, 7) - 1; if (m < 1) { m = 12; y--; } return y + "-" + (m < 10 ? "0" : "") + m; })();
  var price = rev_lessonPrice_();
  var out = {
    ok: true, generated_at: typeof _cairoIso === "function" ? _cairoIso(new Date()) : String(new Date()),
    this_month: thisMonth, last_month: lastMonth, lesson_price: price, currency: "EGP",
    totals: { this_month: { amount: 0, count: 0 }, last_month: { amount: 0, count: 0 }, all_time: { amount: 0, count: 0 },
              pending: { amount: 0, count: 0 } },
    unpriced: { approved: 0, pending: 0, fillable: 0 },
    rows: []
  };
  var P = rev_payments_(ss);
  if (!P || !("status" in P.col)) return out;
  var groups = rev_groupsByPhone_(ss);
  var agg = {};
  for (var r = 1; r < P.values.length; r++) {
    var st = String(rev_cell_(P, r, "status") || "").trim().toLowerCase();
    if (st !== "approved" && st !== "pending") continue;
    var amount = rev_amountOf_(P, r);
    var it = rev_item_(rev_cell_(P, r, "scope"));
    if (amount === null) {
      out.unpriced[st]++;
      if (it.kind === "lesson") out.unpriced.fillable++;
    }
    if (st === "pending") {
      out.totals.pending.count++;
      if (amount !== null) out.totals.pending.amount += amount;
      continue;
    }
    var ym = rev_ym_(rev_cell_(P, r, "decided_at")) || rev_ym_(rev_cell_(P, r, "created_at"));
    var a = amount === null ? 0 : amount;
    out.totals.all_time.count++; out.totals.all_time.amount += a;
    if (ym === thisMonth) { out.totals.this_month.count++; out.totals.this_month.amount += a; }
    if (ym === lastMonth) { out.totals.last_month.count++; out.totals.last_month.amount += a; }
    var group = groups[rev_phoneKey_(rev_cell_(P, r, "phone"))] || "";
    var key = [ym, it.kind, it.item, group].join("\u0001");
    var row = agg[key] || (agg[key] = { month: ym, kind: it.kind, item: it.item, group: group, amount: 0, count: 0, unpriced: 0 });
    row.count++; row.amount += a; if (amount === null) row.unpriced++;
  }
  Object.keys(agg).sort().forEach(function (k) { out.rows.push(agg[k]); });
  return out;
}

function admin_revenue_set_price(payload) {
  if (!rev_isOwner_(payload)) return rev_denied_();
  var n = Number(String(payload && payload.price == null ? "" : payload.price).trim());
  if (!isFinite(n) || n <= 0 || n > REV_MAX_PRICE) return { ok: false, error: "Enter the lesson price as a number of pounds, like 50." };
  n = Math.round(n * 100) / 100;
  _props().setProperty(REV_PRICE_PROP, String(n));
  return { ok: true, price: n };
}

// Option C: give every old LESSON payment (approved or pending) that has no amount today's lesson price.
// Chapter / term rows are never touched. Running it twice changes nothing the second time.
function admin_revenue_fill_old(payload) {
  if (!rev_isOwner_(payload)) return rev_denied_();
  var price = rev_lessonPrice_();
  if (price === null) return { ok: false, error: "Set the lesson price first." };
  var dry = !!(payload && payload.dry_run);
  var work = function () {
    var ss = _ss(), P = rev_payments_(ss);
    if (!P || !("status" in P.col) || !("scope" in P.col)) return { ok: true, price: price, fillable: 0, filled: 0 };
    var rows = [];
    for (var r = 1; r < P.values.length; r++) {
      var st = String(rev_cell_(P, r, "status") || "").trim().toLowerCase();
      if (st !== "approved" && st !== "pending") continue;
      if (rev_item_(rev_cell_(P, r, "scope")).kind !== "lesson") continue;
      if (rev_amountOf_(P, r) !== null) continue;
      rows.push(r + 1);                                       // 1-based sheet row
    }
    if (dry || !rows.length) return { ok: true, price: price, fillable: rows.length, filled: 0 };
    var c = rev_ensureAmountCol_(P.sheet);
    rows.forEach(function (sr) { P.sheet.getRange(sr, c).setValue(price); });
    return { ok: true, price: price, fillable: rows.length, filled: rows.length };
  };
  return dry ? work() : _withLock(work);
}


/* ---------------------------------------------------------------- the teacher's own page (Phase 2.5 F) */

// The caller's context when he may open the teacher page, or null: a teacher by session (his subjects) or the owner.
function rev_teacherCtx_(payload) {
  try {
    var ctx = typeof p4_ctx === "function" ? p4_ctx(payload || {}) : null;
    if (!ctx) return null;
    if (ctx.kind === "owner") return ctx;
    if (ctx.kind === "teacher" && ctx.via === "session" && ctx.subjects && ctx.subjects.length) return ctx;
  } catch (e) { /* denied */ }
  return null;
}

// A tab as {values, col: name -> 0-based index}, or null.
function rev_tab_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return null;
  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues(), col = {};
  values[0].forEach(function (h, i) { h = String(h || "").trim(); if (h && !(h in col)) col[h] = i; });
  return { values: values, col: col };
}

function rev_key_(v) {
  var s = String(v == null ? "" : v).trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  try { if (typeof _canonKey === "function" && s.indexOf("#") === -1) s = _canonKey(s); } catch (e) { /* keep s */ }
  return s;
}

// The course of a lesson = its grade folder: "science/secondary/grade-1-secondary/lesson-1" -> "science/secondary/
// grade-1-secondary". A subscription scope "programming/baccalaureate/grade-1-secondary#ch3" -> its grade folder.
function rev_courseOf_(key) {
  var k = String(key || "");
  if (k.indexOf("#") !== -1) return k.split("#")[0];
  var i = k.lastIndexOf("/");
  return i > 0 ? k.slice(0, i) : k;
}

function rev_day_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v == null ? "" : v).trim());
  return m ? m[1] : "";
}

function rev_flag_(v) { return typeof _isTruthyFlag === "function" ? _isTruthyFlag(v) : v === true || String(v).toLowerCase() === "true"; }

function teacher_revenue_report(payload) {
  var ctx = rev_teacherCtx_(payload);
  if (!ctx) return rev_denied_();
  var mine = function (key) { return !!key && (ctx.kind === "owner" || p4_inSubjects_(ctx, key)); };
  var ss = _ss(), price = rev_lessonPrice_();
  var lessons = {}, courses = {};
  var lessonOf = function (key) {
    var k = rev_key_(key);
    if (!mine(k) || k.indexOf("#") !== -1 || k.split("/").length < 2) return null;
    return lessons[k] || (lessons[k] = { key: k, course: rev_courseOf_(k), videos: 0, paid_videos: 0, visible: true, quiz: false,
                                          price: price, sales: { count: 0, amount: 0 }, pending: 0 });
  };
  var courseOf = function (key) {
    return courses[key] || (courses[key] = { key: key, lessons: 0, videos: 0, sales: { count: 0, amount: 0 }, subscriptions: { count: 0, amount: 0 } });
  };
  var V = rev_tab_(ss, "Videos");
  if (V && "lesson" in V.col) for (var i = 1; i < V.values.length; i++) {
    var L = lessonOf(V.values[i][V.col.lesson]);
    if (!L || ("embed_url" in V.col && !String(V.values[i][V.col.embed_url] || "").trim())) continue;
    L.videos++;
    if ("locked" in V.col && rev_flag_(V.values[i][V.col.locked])) L.paid_videos++;
  }
  var Q = rev_tab_(ss, "QuizContent");
  if (Q && "lesson" in Q.col) for (var q = 1; q < Q.values.length; q++) { var LQ = lessonOf(Q.values[q][Q.col.lesson]); if (LQ) LQ.quiz = true; }
  var LS = rev_tab_(ss, "Lessons");
  if (LS && "lesson" in LS.col && "locked" in LS.col) for (var l = 1; l < LS.values.length; l++) {
    var LL = lessonOf(LS.values[l][LS.col.lesson]);
    if (LL && rev_flag_(LS.values[l][LS.col.locked])) LL.visible = false;
  }
  var out = { ok: true, generated_at: typeof _cairoIso === "function" ? _cairoIso(new Date()) : String(new Date()),
              subjects: ctx.kind === "owner" ? ["*"] : ctx.subjects.slice(), currency: "EGP", lesson_price: price,
              cards: { students: 0, courses: 0, lessons: 0, purchases: 0, total_sales: 0, pending: 0, unpriced: 0 },
              courses: [], lessons: [], purchases: [] };
  var P = rev_payments_(ss);
  if (P && "status" in P.col && "scope" in P.col) for (var r = 1; r < P.values.length; r++) {
    var st = String(rev_cell_(P, r, "status") || "").trim().toLowerCase();
    if (st !== "approved" && st !== "pending") continue;
    var scope = rev_key_(rev_cell_(P, r, "scope"));
    if (!mine(scope)) continue;
    var it = rev_item_(scope), amount = rev_amountOf_(P, r);
    var LP = it.kind === "lesson" ? lessonOf(scope) : null;
    if (st === "pending") { out.cards.pending++; if (LP) LP.pending++; continue; }
    out.cards.purchases++; out.cards.total_sales += amount || 0;
    if (amount === null) out.cards.unpriced++;
    var C = courseOf(rev_courseOf_(scope));
    if (LP) { LP.sales.count++; LP.sales.amount += amount || 0; }
    else { C.subscriptions.count++; C.subscriptions.amount += amount || 0; }
    out.purchases.push({ date: rev_day_(rev_cell_(P, r, "decided_at")) || rev_day_(rev_cell_(P, r, "created_at")),
                         student: String(rev_cell_(P, r, "name") == null ? "" : rev_cell_(P, r, "name")).trim().slice(0, 80),
                         item: scope, kind: it.kind, course: rev_courseOf_(scope), amount: amount, method: "website" });
  }
  Object.keys(lessons).sort().forEach(function (k) {
    var L = lessons[k], C = courseOf(L.course);
    out.lessons.push(L);
    C.lessons++; C.videos += L.videos; C.sales.count += L.sales.count; C.sales.amount += L.sales.amount;
  });
  Object.keys(courses).sort().forEach(function (k) {
    var C = courses[k];
    C.total = { count: C.sales.count + C.subscriptions.count, amount: C.sales.amount + C.subscriptions.amount };
    out.courses.push(C);
  });
  out.purchases.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  out.cards.courses = out.courses.length;
  out.cards.lessons = out.lessons.length;
  try {
    if (ctx.kind === "owner") {
      out.cards.students = _sheetValuesAsObjects(_students()).filter(function (s) { return !rev_flag_(s.is_admin) && !String(s.role || "").trim(); }).length;
    } else {
      out.cards.students = typeof p4_linked_ === "function" ? p4_linked_(ctx).length : 0;
    }
  } catch (e) { out.cards.students = 0; }
  return out;
}
