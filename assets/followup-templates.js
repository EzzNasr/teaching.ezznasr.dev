/* ==========================================================================
   followup-templates.js — message engine + template editor for the Follow-up
   dashboard (dashboard/followup.html). Chunk 4 of the follow-up build guide
   (sections 4.3 - 4.5). UMD: window.FollowupTemplates in browsers,
   module.exports in Node. No network, no dependency on the other chunks'
   code: everything it needs arrives as plain arguments (see "Inputs").

   What it does
     - DEFAULTS      every built-in template (Egyptian Arabic, gender-neutral,
                     WhatsApp-formatted), including the shared `header`.
     - PLACEHOLDERS  name -> {ar, en} descriptions (for the editor chips).
     - render()      {placeholder} substitution with the empty-line and
                     bidi-isolate rules; unknown placeholders stay visible.
     - buildContext  the placeholder map for one student + one lesson.
     - compose()     ready-to-send text for one template, the combined
                     message, or the group reminder.
     - formatPreview WhatsApp-style *bold* / _italic_ / ~strike~ as safe HTML.
     - waLink / copyText / lintMessage / helpers.
     - mountEditor   the phone-friendly template editor (needs
                     followup-templates.css on the page).

   Inputs (all plain data, same shapes as the overview API, section 3.1)
     student   { name, phone, parent_phone }
     group     { group, settings: { current_lesson, review_lessons[],
                 note, parents_contacted, weekday, time } }
     lessons   overview.lessons   (path -> {has_video, has_quiz,
                 has_assignment, ...}); optional. Used to decide which
                 lessons appear in {hw_list} / {watch_list}.
     facts     overview.facts[phoneKey]  (lessonPath -> {watch_pct, quiz:
                 {taken, score, total}, homework:{submitted}, ...})
     verdicts  { session:{lesson,state}, homework:[{lesson,state}],
                 quiz:[{lesson,state}] }   (the FollowupLogic output,
                 section 4.2 - only the `state` strings are read)
     deadlines { watch, hw, nextSession }  each a Date, an ISO string, a
                 "yyyy-MM-dd" string, or an object holding one of those in
                 .date / .ymd / .iso / .at / .deadline. (Also accepted:
                 watchDeadline / hwDeadline, watch_deadline / hw_deadline.)
     now       Date (defaults to new Date())
     templates saved overrides { key: body }
   ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FollowupTemplates = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var FSI = "\u2068";   // first-strong isolate
  var PDI = "\u2069";   // pop directional isolate
  var MAX_LEN = 1200;
  var TZ = "Africa/Cairo";
  var VERSION = "1.0.0";

  // ------------------------------------------------------------------ defaults
  // Written exactly as in the build guide (section 4.5). `{H}` expands to the
  // shared, editable `header` template when the message is rendered.
  function J() { return Array.prototype.slice.call(arguments).join("\n"); }

  var DEFAULTS = {
    header: J(
      "السلام عليكم 👋",
      "",
      "مع حضرتك *فريق الدعم لبشمهندس عز نصر* في مادة البرمجة 💻",
      "", ""
    ),

    session_unwatched: J(
      "{H}كنا بنتواصل مع حضرتك عشان نبلغك إن حصة 📚 *{lesson}* لم تُشاهَد من *{student_name}* حتى الآن ⏳",
      "",
      "⚠️ الحصة مهمة وداخلة في *امتحان الشهر الحالي*، فضلًا عن كونها في *الامتحان الأسبوعي* لكل حصة.",
      "",
      "🎯 مهم جدًا إنهم يتفرجوا على الحصة في أسرع وقت، عشان يكون عندهم وقت كافي يستفسروا ويطبقوا على الدرس قبل الحصة الجاية.",
      "",
      "💬 ولو عندهم أي سؤال في المنصة أو المادة العلمية، إحنا موجودين دايمًا علشان نساعدهم 🌷"
    ),

    session_unfinished: J(
      "{H}كنا بنتواصل مع حضرتك عشان نبلغك إن مشاهدة *{student_name}* لحصة 📚 *{lesson}* لسه ما اكتملتش ▶️ (اتشاف منها *{watch_pct}%* بس)",
      "",
      "⚠️ الحصة مهمة وداخلة في *امتحان الشهر الحالي*، فضلًا عن كونها في *الامتحان الأسبوعي* لكل حصة.",
      "",
      "🎯 مهم جدًا إنهم يكمّلوا الحصة في أسرع وقت، عشان يكون عندهم وقت كافي يستفسروا ويطبقوا على الدرس قبل الحصة الجاية.",
      "",
      "💬 ولو عندهم أي سؤال في المنصة أو المادة العلمية، إحنا موجودين دايمًا علشان نساعدهم 🌷"
    ),

    session_done: J(
      "{H}✅ حابين نطمّن حضرتك إن مشاهدة *{student_name}* لحصة 📚 *{lesson}* اتمّت بالكامل",
      "",
      "🌟 الالتزام ده بيفرق جدًا في المستوى، وشكرًا لحضرتك على المتابعة 🌷"
    ),

    homework_missing: J(
      "{H}📝 حابين نفكّر حضرتك إن واجب *{lesson}* لسه ماتسلّمش على المنصة من *{student_name}*",
      "",
      "⏰ آخر معاد للتسليم: *{deadline_when}*",
      "",
      "🎯 مهم جدًا إنهم يسلّموه في معاده عشان نقدر نراجعه معاهم قبل الحصة الجاية.",
      "",
      "💬 ولو في أي مشكلة في المنصة أو في حل الواجب، إحنا موجودين دايمًا علشان نساعدهم 🌷"
    ),

    homework_done: J(
      "{H}✅ حابين نطمّن حضرتك إن واجب *{lesson}* اتسلّم على المنصة من *{student_name}*",
      "",
      "🌟 شكرًا لحضرتك على المتابعة، وبنتمنى لهم دايمًا التوفيق 🌷"
    ),

    quiz_mark: J(
      "{H}📊 نتيجة *{student_name}* في كويز *{lesson}*:",
      "",
      "🎯 *{score} من {total}* ({quiz_pct}%)",
      "",
      "💬 ولو في أي استفسار عن النتيجة أو الأسئلة، إحنا موجودين دايمًا علشان نساعدهم 🌷"
    ),

    quiz_praise: J(
      "{H}👏 ما شاء الله! نتيجة *{student_name}* في كويز *{lesson}* هي *{score} من {total}* ({quiz_pct}%)",
      "",
      "🌟 مستوى ممتاز، وشكرًا لحضرتك على المتابعة 🌷"
    ),

    quiz_absent: J(
      "{H}⚠️ حابين ننبّه حضرتك إن كويز *{lesson}* لسه ماتحلّش من *{student_name}*، ولازم *يتعوّض* في أقرب وقت.",
      "",
      "📚 الكويز ده مهم لمراجعة الحصة قبل الحصة الجاية.",
      "",
      "💬 ولو في أي مشكلة في الدخول عليه، إحنا موجودين دايمًا علشان نساعدهم 🌷"
    ),

    line_session_unwatched: "▶️ حصة *{lesson}*: لم تُشاهَد حتى الآن",
    line_session_unfinished: "▶️ حصة *{lesson}*: المشاهدة لم تكتمل (*{watch_pct}%* بس)",
    line_homework_missing: "📝 واجب *{lesson}*: لم يتم تسليمه على المنصة",
    line_quiz_absent: "❓ كويز *{lesson}*: لم يتم حله — ولازم *يتعوّض*",

    combined: J(
      "{H}كنا بنتواصل مع حضرتك عشان نبلغك بالآتي بخصوص *{student_name}* 📌",
      "",
      "{issues}",
      "",
      "🎯 مهم جدًا إنهم يلحقوا كل ده في أقرب وقت عشان يكون عندهم وقت كافي يستفسروا ويطبقوا قبل الحصة الجاية.",
      "",
      "💬 ولو عندهم أي سؤال في المنصة أو المادة العلمية، إحنا موجودين دايمًا علشان نساعدهم 🌷"
    ),

    // Phase 2 (Session 2): the monthly review sent to a parent. Every {*_line} is built from the student summary
    // and is dropped when empty; {review_lines} lists what still has to be made up.
    monthly_review: J(
      "{H}📅 *التقرير الشهري — {month_label}* بخصوص *{student_name}* 📌",
      "",
      "{quiz_line}",
      "{homework_line}",
      "{attendance_line}",
      "{watch_line}",
      "",
      "{missed_line}",
      "{review_lines}",
      "",
      "💬 ولو عندهم أي سؤال في المنصة أو المادة العلمية، إحنا موجودين دايمًا علشان نساعدهم 🌷"
    ),

    group_reminder: J(
      "السلام عليكم 👋",
      "",
      "📣 *تذكير مهم*",
      "",
      "من فضلكم نسلّم الواجب على المنصة ✍️",
      "",
      "{hw_list}",
      "",
      "{parents_contacted_line}",
      "",
      "⏰ *{deadline_when} آخر معاد* لتسليم الواجبات بإذن الله، وبعدها هيتم التواصل مع أولياء الأمور 🙏"
    )
  };

  // Fixed wording used inside {hw_list} / {watch_list} / {parents_contacted_line}.
  // Not editable (they are building blocks, not messages).
  var LIST_ITEMS = {
    hw: "نتأكد من تسليم واجب *{lesson}*",
    watch: "نتأكد من مشاهدة حصة *{lesson}*",
    parents_contacted: "📞 تم التواصل مع أولياء أمور الطلاب اللي ماخلّصوش الحصة لحد دلوقتي"
  };

  // Editor tab order + Arabic labels.
  var ORDER = [
    "session_unwatched", "session_unfinished", "homework_missing", "quiz_absent",
    "quiz_mark", "combined", "group_reminder", "monthly_review",
    "session_done", "homework_done", "quiz_praise",
    "line_session_unwatched", "line_session_unfinished", "line_homework_missing", "line_quiz_absent",
    "header"
  ];
  var LABELS = {
    header: "الترويسة المشتركة",
    session_unwatched: "حصة لم تُشاهَد",
    session_unfinished: "مشاهدة ناقصة",
    session_done: "شكر: مشاهدة",
    homework_missing: "واجب ناقص",
    homework_done: "شكر: واجب",
    quiz_mark: "نتيجة الكويز",
    quiz_praise: "كويز ممتاز",
    quiz_absent: "غياب كويز",
    line_session_unwatched: "سطر: حصة لم تُشاهَد",
    line_session_unfinished: "سطر: مشاهدة ناقصة",
    line_homework_missing: "سطر: واجب ناقص",
    line_quiz_absent: "سطر: غياب كويز",
    combined: "رسالة مجمّعة",
    group_reminder: "تذكير للجروب",
    monthly_review: "تقرير شهري"
  };

  var PLACEHOLDERS = {
    student_name: { ar: "اسم الطالب", en: "Student display name" },
    student_first_name: { ar: "الاسم الأول للطالب", en: "Student first name" },
    group: { ar: "اسم الجروب", en: "Group name" },
    lesson: { ar: "اسم الدرس (حسب نوع الرسالة)", en: "Lesson of this template's role (current lesson for session templates, homework & quiz lesson otherwise)" },
    lesson_slug: { ar: "اسم الدرس كما هو في الرابط", en: "Raw lesson slug" },
    lesson_current: { ar: "الحصة الحالية", en: "The group's current lesson" },
    lesson_review: { ar: "درس الواجب والكويز", en: "The group's first homework & quiz lesson" },
    watch_pct: { ar: "نسبة المشاهدة %", en: "Watched percentage" },
    score: { ar: "درجة الكويز", en: "Quiz score" },
    total: { ar: "الدرجة الكاملة للكويز", en: "Quiz total" },
    quiz_pct: { ar: "نسبة الكويز %", en: "Quiz percentage" },
    hw_deadline: { ar: "ميعاد الواجب (يوم/شهر)", en: "Homework deadline d/m" },
    watch_deadline: { ar: "ميعاد المشاهدة (يوم/شهر)", en: "Watch deadline d/m" },
    deadline_when: { ar: "النهارده / بكرة / يوم كذا", en: "Deadline phrase (today / tomorrow / weekday d/m)" },
    session_when: { ar: "ميعاد الحصة الجاية", en: "Next session phrase" },
    group_note: { ar: "ملاحظات الجروب", en: "Group note" },
    hw_list: { ar: "قائمة الواجبات (مرقّمة)", en: "Numbered homework list" },
    watch_list: { ar: "قائمة المشاهدة (مرقّمة)", en: "Numbered watch list" },
    parents_contacted_line: { ar: "سطر «تم التواصل مع أولياء الأمور» (لو مفعّل)", en: "Parents-contacted line (only when the group flag is on)" },
    issues: { ar: "قائمة المشاكل (للرسالة المجمّعة)", en: "Joined issue lines (combined message)" },
    month_label: { ar: "الشهر (أكتوبر 2026)", en: "Month and year in Arabic" },
    quiz_line: { ar: "سطر الكويزات (العدد والمتوسط)", en: "Quiz count and average line" },
    homework_line: { ar: "سطر الواجبات (المسلَّم من المطلوب)", en: "Homework submitted vs required line" },
    attendance_line: { ar: "سطر الحضور (سنتر / أونلاين)", en: "Attendance line" },
    watch_line: { ar: "سطر متوسط المشاهدة", en: "Average watch line" },
    missed_line: { ar: "سطر المطلوب تعويضه", en: "What has to be made up (count line)" },
    review_lines: { ar: "تفاصيل ما فات (سطر لكل درس)", en: "One line per missed item" }
  };

  // Values that carry their own markup (or are already isolated): inserted as-is.
  var RAW_KEYS = { hw_list: 1, watch_list: 1, issues: 1, parents_contacted_line: 1, deadline_when: 1, session_when: 1,
                   month_label: 1, quiz_line: 1, homework_line: 1, attendance_line: 1, watch_line: 1, missed_line: 1, review_lines: 1 };
  // Values wrapped in bidi isolates (LTR runs inside Arabic text, names that may be Latin).
  var ISOLATE_KEYS = {
    student_name: 1, student_first_name: 1, group: 1, lesson: 1, lesson_slug: 1, lesson_current: 1,
    lesson_review: 1, watch_pct: 1, score: 1, total: 1, quiz_pct: 1, hw_deadline: 1, watch_deadline: 1
  };

  var AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  var KEYCAPS = ["1\uFE0F\u20E3", "2\uFE0F\u20E3", "3\uFE0F\u20E3", "4\uFE0F\u20E3", "5\uFE0F\u20E3", "6\uFE0F\u20E3", "7\uFE0F\u20E3", "8\uFE0F\u20E3", "9\uFE0F\u20E3"];

  var PH_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  // ------------------------------------------------------------------ small helpers
  function str(v) { return v == null ? "" : String(v); }

  // Strip the WhatsApp markup characters and any bidi controls from DATA that is
  // about to be inserted into a template, so a name like "Ali *x*" cannot bold
  // (or un-bold) anything, and stray isolates cannot unbalance ours.
  function clean(v) {
    return str(v)
      .replace(/[*_~`]/g, "")
      .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .replace(/\s*[\r\n]+\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function lessonSlug(path) {
    var p = str(path).replace(/[#?].*$/, "").replace(/\/+$/, "");
    var i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
  }
  // Real lesson names (path -> title) are optional: the page passes them in via setLessonTitles().
  // Without them (or for an unknown lesson) the old slug-based name is used, so behaviour is unchanged.
  var _lessonTitles = {};
  function setLessonTitles(map) { _lessonTitles = map && typeof map === "object" ? map : {}; }
  function prettyLesson(path) {
    var t = _lessonTitles[path];
    if (t && typeof t === "string") return t.replace(/\s+/g, " ").trim();
    return lessonSlug(path).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function firstName(name) { return clean(name).split(" ")[0] || ""; }

  function iso(s, useIso) { return useIso && s !== "" ? FSI + s + PDI : s; }

  // ---- Cairo calendar helpers (never the browser's zone) ----
  var _fmtCache = {};
  function _fmt(opts) {
    var k = JSON.stringify(opts);
    return _fmtCache[k] || (_fmtCache[k] = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: TZ }, opts)));
  }
  function cairoParts(d) {
    var parts = _fmt({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return { y: +o.year, m: +o.month, d: +o.day, H: +o.hour % 24, M: +o.minute };
  }
  function ymdString(p) { return p.y + "-" + ("0" + p.m).slice(-2) + "-" + ("0" + p.d).slice(-2); }
  function dayNumber(ymd) { // days since epoch for a "yyyy-MM-dd" calendar date
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
    return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
  }
  function weekdayOf(ymd) { return new Date(dayNumber(ymd) * 86400000).getUTCDay(); }

  // Accepts a Date, a number, an ISO string, "yyyy-MM-dd" or {date|ymd|iso|at|deadline}.
  function toYmd(x) {
    if (x == null || x === "") return "";
    if (typeof x === "object" && !(x instanceof Date)) x = x.date || x.ymd || x.iso || x.at || x.deadline || "";
    if (x === "" || x == null) return "";
    if (typeof x === "string") {
      var m = /^(\d{4}-\d{2}-\d{2})/.exec(x.trim());
      if (m) return m[1];
      x = new Date(x);
    } else if (typeof x === "number") x = new Date(x);
    if (!(x instanceof Date) || isNaN(x.getTime())) return "";
    return ymdString(cairoParts(x));
  }
  function toDate(x) {
    if (x == null || x === "") return null;
    if (typeof x === "object" && !(x instanceof Date)) x = x.iso || x.at || x.date || "";
    var d = x instanceof Date ? x : new Date(x);
    return isNaN(d.getTime()) ? null : d;
  }

  function dm(ymd) { var m = /^\d{4}-(\d{2})-(\d{2})/.exec(ymd); return m ? (+m[2]) + "/" + (+m[1]) : ""; }

  // "النهارده" / "بكرة" / "يوم السبت 17/10"
  function deadlineWhen(deadline, now, useIso) {
    var ymd = toYmd(deadline);
    if (!ymd) return "";
    var today = ymdString(cairoParts(now || new Date()));
    var diff = dayNumber(ymd) - dayNumber(today);
    if (diff === 0) return "النهارده";
    if (diff === 1) return "بكرة";
    return "يوم " + AR_DAYS[weekdayOf(ymd)] + " " + iso(dm(ymd), useIso !== false);
  }

  // "يوم السبت 17/10 الساعة 6:00 م"
  function sessionWhen(next, useIso) {
    var d = toDate(next);
    if (!d) return "";
    var p = cairoParts(d), ymd = ymdString(p);
    var h = p.H % 12 || 12, mm = ("0" + p.M).slice(-2), suf = p.H >= 12 ? "م" : "ص";
    return "يوم " + AR_DAYS[weekdayOf(ymd)] + " " + iso(dm(ymd), useIso !== false) + " الساعة " + iso(h + ":" + mm, useIso !== false) + " " + suf;
  }

  function pickDeadline(deadlines, which) {
    deadlines = deadlines || {};
    return which === "watch"
      ? (deadlines.watch != null ? deadlines.watch : deadlines.watchDeadline != null ? deadlines.watchDeadline : deadlines.watch_deadline)
      : (deadlines.hw != null ? deadlines.hw : deadlines.hwDeadline != null ? deadlines.hwDeadline : deadlines.hw_deadline);
  }

  // ------------------------------------------------------------------ verdict -> template
  var SESSION_STATE_TEMPLATE = {
    session_unwatched: "session_unwatched",
    session_locked: "session_unwatched",   // locked video -> same "hasn't watched" message
    session_unfinished: "session_unfinished",
    session_done: "session_done"
  };
  function templateForState(state) {
    if (hasOwn(SESSION_STATE_TEMPLATE, state)) return SESSION_STATE_TEMPLATE[state];
    if (state === "homework_missing" || state === "homework_done" || state === "quiz_absent") return state;
    return "";
  }
  function roleOfKind(kind) {
    kind = str(kind).replace(/^line_/, "");
    if (/^session_/.test(kind)) return "session";
    if (/^homework_/.test(kind)) return "homework";
    if (/^quiz_/.test(kind)) return "quiz";
    return kind === "group_reminder" ? "group" : "";
  }

  // The negative items of a student's verdicts, in the order they appear in the
  // combined message: session, then homework, then quiz.
  function deriveIssues(verdicts) {
    var out = [];
    if (!verdicts) return out;
    var s = verdicts.session;
    if (s && (s.state === "session_unwatched" || s.state === "session_locked")) out.push({ template: "session_unwatched", lesson: s.lesson });
    else if (s && s.state === "session_unfinished") out.push({ template: "session_unfinished", lesson: s.lesson });
    (verdicts.homework || []).forEach(function (h) { if (h && h.state === "homework_missing") out.push({ template: "homework_missing", lesson: h.lesson }); });
    (verdicts.quiz || []).forEach(function (q) { if (q && q.state === "quiz_absent") out.push({ template: "quiz_absent", lesson: q.lesson }); });
    return out;
  }

  // ------------------------------------------------------------------ context
  function factsFor(facts, lesson) {
    if (!facts) return {};
    if (lesson && facts[lesson] && typeof facts[lesson] === "object") return facts[lesson];
    // a single lesson's fact object was passed directly
    if ("watch_pct" in facts || "quiz" in facts || "homework" in facts || "attendance" in facts) return facts;
    return {};
  }

  function isoOn(input) {
    if (input && input.isolates === false) return false;
    if (input && input.settings && input.settings.bidi_isolates === false) return false;
    return true;
  }

  /**
   * Placeholder map for one student and one lesson.
   * input: { student, group, lesson, kind, facts, deadlines, now, lessons, settings, isolates }
   * `kind` (template key, optional) decides which deadline {deadline_when} means:
   * session_* -> the watch deadline, everything else -> the homework deadline.
   * Every placeholder of PLACEHOLDERS is present in the result ("" when there is
   * no data), so a message never shows a raw {name} for a known placeholder.
   */
  function buildContext(input) {
    input = input || {};
    var student = input.student || {}, group = input.group || {}, gs = group.settings || {};
    var useIso = isoOn(input);
    var now = input.now || new Date();
    var cur = gs.current_lesson || "";
    var rev = Array.isArray(gs.review_lessons) ? gs.review_lessons : [];
    var role = roleOfKind(input.kind);
    var lesson = input.lesson || (role === "session" ? cur : (rev[0] || cur));
    var fact = factsFor(input.facts, lesson);
    var quiz = fact.quiz && fact.quiz.taken ? fact.quiz : null;
    var score = quiz && quiz.score != null ? quiz.score : "";
    var total = quiz && quiz.total != null ? quiz.total : "";
    var quizPct = (score !== "" && +total > 0) ? Math.round((+score / +total) * 100) : "";
    var pct = fact.watch_pct != null && isFinite(+fact.watch_pct) ? Math.round(+fact.watch_pct) : "";

    var watchD = pickDeadline(input.deadlines, "watch"), hwD = pickDeadline(input.deadlines, "hw");
    var whichD = role === "session" ? watchD : hwD;

    var ctx = {
      student_name: str(student.name || student.display_name || student.phone),
      student_first_name: firstName(student.name || student.display_name || ""),
      group: str(group.group || group.name),
      lesson: prettyLesson(lesson),
      lesson_slug: lessonSlug(lesson),
      lesson_current: prettyLesson(cur),
      lesson_review: prettyLesson(rev[0] || ""),
      watch_pct: pct === "" ? "" : String(pct),
      score: score === "" ? "" : String(score),
      total: total === "" ? "" : String(total),
      quiz_pct: quizPct === "" ? "" : String(quizPct),
      hw_deadline: dm(toYmd(hwD)),
      watch_deadline: dm(toYmd(watchD)),
      deadline_when: deadlineWhen(whichD, now, useIso),
      session_when: sessionWhen(pickDeadline(input.deadlines, "next") || (input.deadlines && input.deadlines.nextSession), useIso),
      group_note: str(gs.note),
      hw_list: "", watch_list: "", parents_contacted_line: "", issues: ""
    };
    ctx.__isolates = useIso;
    return ctx;
  }

  function numbered(i) { return i < 9 ? KEYCAPS[i] : (i + 1) + "-"; }

  function lessonFlag(lessons, path, flag) {
    var l = lessons && lessons[path];
    return !l || l[flag] !== false;   // unknown lesson info -> include it
  }

  function buildLists(input, ctx, useIso) {
    var gs = (input.group && input.group.settings) || {};
    var rev = Array.isArray(gs.review_lessons) ? gs.review_lessons : [];
    var lessons = input.lessons || {};
    function list(paths, tpl, flag) {
      var shown = paths.filter(function (p) { return p && lessonFlag(lessons, p, flag); });
      return shown.map(function (p, i) {
        var line = tpl.replace("{lesson}", iso(clean(prettyLesson(p)), useIso));
        return numbered(i) + " " + line;
      }).join("\n");
    }
    ctx.hw_list = list(rev, LIST_ITEMS.hw, "has_assignment");
    ctx.watch_list = list(gs.current_lesson ? [gs.current_lesson] : [], LIST_ITEMS.watch, "has_video");
    ctx.parents_contacted_line = gs.parents_contacted ? LIST_ITEMS.parents_contacted : "";
  }

  // ------------------------------------------------------------------ render
  function fmtValue(name, v, useIso) {
    var s = str(v);
    if (hasOwn(RAW_KEYS, name)) return s;
    s = clean(s);
    return hasOwn(ISOLATE_KEYS, name) ? iso(s, useIso) : s;
  }

  /**
   * render(body, ctx[, {header, isolates}]) -> { text, missing }
   *  - {H} expands to the header template (opts.header, ctx.H or DEFAULTS.header)
   *  - unknown {placeholders} stay visible and are listed in `missing`
   *  - a non-blank template line whose placeholders all render "" is dropped
   *  - runs of blank lines collapse to one; leading/trailing blanks are trimmed
   *  - data values lose * _ ~ ` and get bidi isolates (markers stay OUTSIDE them)
   */
  function render(body, ctx, opts) {
    opts = opts || {}; ctx = ctx || {};
    var useIso = opts.isolates !== false && ctx.__isolates !== false;
    var text = str(body).replace(/\r\n?/g, "\n");
    if (/\{H\}/.test(text)) {
      var h = str(opts.header != null ? opts.header : (ctx.H != null ? ctx.H : DEFAULTS.header)).replace(/\r\n?/g, "\n");
      h = h.trim() ? h.replace(/\s+$/, "") + "\n\n" : "";
      text = text.replace(/\{H\}/g, function () { return h; });
    }
    var missing = [];
    var out = [];
    text.split("\n").forEach(function (line) {
      var had = false, wasBlank = line.trim() === "";
      var r = line.replace(PH_RE, function (m, name) {
        had = true;
        if (!hasOwn(ctx, name) || ctx[name] == null) {
          if (missing.indexOf(name) < 0) missing.push(name);
          return m;
        }
        return fmtValue(name, ctx[name], useIso);
      });
      if (had && !wasBlank && r.trim() === "") return;   // optional line that became empty
      out.push(r);
    });
    text = out.join("\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s+/, "").replace(/\s+$/, "");
    return { text: text, missing: missing };
  }

  // Keep a message <= MAX_LEN: drop whole paragraphs from the end (never the first
  // two = the header, never a paragraph that carries list/issue content), the very
  // last one only at the end; hard-cut as a last resort.
  function fit(text, protect, max) {
    max = max || MAX_LEN;
    if (text.length <= max) return { text: text, trimmed: false };
    var paras = text.split("\n\n"), dropped = {}, order = [], i;
    function isProtected(p) { return (protect || []).some(function (x) { return x && x.indexOf(p) >= 0; }); }
    function joined() { return paras.filter(function (p, j) { return !dropped[j]; }).join("\n\n"); }
    for (i = paras.length - 2; i >= 2; i--) order.push(i);
    if (paras.length > 2) order.push(paras.length - 1);
    for (i = 0; i < order.length && joined().length > max; i++) {
      if (!isProtected(paras[order[i]])) dropped[order[i]] = true;
    }
    var res = joined();
    if (res.length > max) {
      var cut = res.slice(0, max - 1), nl = cut.lastIndexOf("\n");
      res = (nl > max * 0.6 ? cut.slice(0, nl) : cut).replace(/\s+$/, "") + "\u2026";
    }
    return { text: res, trimmed: true };
  }

  // ------------------------------------------------------------------ compose
  function bodyFor(key, templates) {
    var t = templates && templates[key];
    return typeof t === "string" && t.trim() !== "" ? t : (DEFAULTS[key] != null ? DEFAULTS[key] : "");
  }

  /**
   * composeFull(summary, kind, ctx) -> { text, missing, trimmed, kind }
   *   summary : { student, group, verdicts }   (FollowupLogic.studentSummary shape; only these keys are read)
   *   kind    : a template key (session_unwatched, session_unfinished, session_done, homework_missing,
   *             homework_done, quiz_mark, quiz_praise, quiz_absent), "combined" or "group_reminder"
   *   ctx     : { facts, deadlines, now, lessons, templates, lesson, issues, settings, student, group, isolates }
   *             `lesson` picks the homework/quiz lesson when a group has several (one message per lesson);
   *             `issues` ([{template, lesson}]) overrides what the combined message lists.
   */
  function composeFull(summary, kind, ctx) {
    if (kind === "monthly_review") return composeMonthly(summary, ctx);
    summary = summary || {}; ctx = ctx || {};
    var input = {
      student: ctx.student || summary.student || {},
      group: ctx.group || summary.group || {},
      verdicts: ctx.verdicts || summary.verdicts || null,
      facts: ctx.facts, deadlines: ctx.deadlines, now: ctx.now || new Date(),
      lessons: ctx.lessons, settings: ctx.settings, isolates: ctx.isolates,
      lesson: ctx.lesson, kind: kind
    };
    var templates = ctx.templates || {};
    var useIso = isoOn(input);
    var gs = (input.group && input.group.settings) || {};
    var rev = Array.isArray(gs.review_lessons) ? gs.review_lessons : [];

    // Which lesson does this template talk about?
    if (!input.lesson) {
      var role = roleOfKind(kind), v = input.verdicts;
      if (role === "session") input.lesson = gs.current_lesson || (v && v.session && v.session.lesson) || "";
      else if (role === "homework" || role === "quiz") {
        var arr = role === "homework" ? (v && v.homework) : (v && v.quiz);
        var hit = (arr || []).filter(function (x) { return x && templateForState(x.state) === kind; })[0];
        input.lesson = (hit && hit.lesson) || rev[0] || "";
      } else input.lesson = gs.current_lesson || "";
    }

    var c = buildContext(input);
    buildLists(input, c, useIso);

    var issueList = ctx.issues || deriveIssues(input.verdicts);
    var lines = issueList.map(function (is) {
      var lk = "line_" + is.template;
      var ic = buildContext({ student: input.student, group: input.group, lesson: is.lesson, kind: is.template, facts: input.facts, deadlines: input.deadlines, now: input.now, isolates: input.isolates, settings: input.settings });
      return render(bodyFor(lk, templates), ic, { isolates: useIso }).text;
    }).filter(Boolean);
    c.issues = lines.join("\n\n");

    var header = bodyFor("header", templates);
    var r = render(bodyFor(kind, templates), c, { header: header, isolates: useIso });
    var f = fit(r.text, [c.issues, c.hw_list, c.watch_list], MAX_LEN);
    return { text: f.text, missing: r.missing, trimmed: f.trimmed, kind: kind };
  }

  // ------------------------------------------------------------------ monthly review (Phase 2)
  var MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  function monthLabel(month) {
    var m = /^(\d{4})-(\d{2})$/.exec(str(month));
    return m && +m[2] >= 1 && +m[2] <= 12 ? MONTHS_AR[+m[2] - 1] + " " + m[1] : str(month);
  }
  function rnd(n) { return Math.round(+n * 10) / 10; }
  /**
   * composeMonthly(summary, ctx) -> { text, missing, trimmed, kind }
   *   summary : the `summary` object of one admin_monthly_review / admin_student_summary result
   *             ({student, groups, totals, expected, ...})
   *   ctx     : { month: "2026-10", templates, isolates }
   * Same text for the WhatsApp message, the copy button and the printable page, so the three can never disagree.
   */
  function composeMonthly(summary, ctx) {
    summary = summary || {}; ctx = ctx || {};
    var tot = summary.totals || {}, exp = summary.expected || [], st = summary.student || {};
    var useIso = ctx.isolates !== false;
    var reqHw = exp.filter(function (e) { return e.homework && e.homework.required; });
    var hwDone = reqHw.filter(function (e) { return e.homework.done; }).length;
    var c = {
      student_name: str(st.name || st.phone), student_first_name: str(st.name || "").split(/\s+/)[0],
      group: str(summary.groups && summary.groups[0] ? summary.groups[0].group : ""),
      month_label: monthLabel(ctx.month || (summary.range && String(summary.range.from).slice(0, 7)) || (ctx.now instanceof Date ? ctx.now : new Date()).toISOString().slice(0, 7)),
      lesson: "", lesson_slug: "", lesson_current: "", lesson_review: "", watch_pct: "", score: "", total: "", quiz_pct: "",
      hw_deadline: "", watch_deadline: "", deadline_when: "", session_when: "", group_note: "", hw_list: "", watch_list: "", parents_contacted_line: "", issues: "",
      quiz_line: tot.quiz_count ? "📝 الكويزات: *" + tot.quiz_count + "* " + (tot.quiz_count === 1 ? "كويز" : "كويزات") + (tot.quiz_avg_pct != null ? " — المتوسط *" + rnd(tot.quiz_avg_pct) + "%*" : "") : "📝 الكويزات: لم يتم حل أي كويز هذا الشهر",
      homework_line: reqHw.length ? "✍️ الواجبات: سُلّم *" + hwDone + "* من *" + reqHw.length + "* المطلوب" : (tot.homework_count ? "✍️ الواجبات: سُلّم *" + tot.homework_count + "*" : ""),
      attendance_line: (tot.attendance_center || tot.attendance_online) ? "🏫 الحضور: *" + (tot.attendance_center || 0) + "* سنتر · *" + (tot.attendance_online || 0) + "* أونلاين" : "",
      watch_line: tot.watch_avg_pct != null ? "▶️ متوسط المشاهدة: *" + rnd(tot.watch_avg_pct) + "%*" : "",
      missed_line: "", review_lines: ""
    };
    var parts = [];
    if (tot.quiz_missed) parts.push("*" + tot.quiz_missed + "* " + (tot.quiz_missed === 1 ? "كويز" : "كويزات"));
    if (tot.homework_missed) parts.push("*" + tot.homework_missed + "* " + (tot.homework_missed === 1 ? "واجب" : "واجبات"));
    if (parts.length) c.missed_line = "⚠️ المطلوب تعويضه: " + parts.join(" و ");
    var lines = [];
    exp.forEach(function (e) {
      var nm = iso(clean(prettyLesson(e.lesson)), useIso);
      if (e.quiz && e.quiz.missed) lines.push("• كويز *" + nm + "*: لم يتم حله");
      if (e.homework && e.homework.missed) lines.push("• واجب *" + nm + "*: لم يتم تسليمه");
    });
    c.review_lines = lines.slice(0, 8).join("\n") + (lines.length > 8 ? "\n• …و " + (lines.length - 8) + " غير كده" : "");
    c.__isolates = useIso;
    var templates = ctx.templates || {};
    var r = render(bodyFor("monthly_review", templates), c, { header: bodyFor("header", templates), isolates: useIso });
    var f = fit(r.text, [c.review_lines], MAX_LEN);
    return { text: f.text, missing: r.missing, trimmed: f.trimmed, kind: "monthly_review" };
  }
  function compose(summary, kind, ctx) { return composeFull(summary, kind, ctx).text; }

  // ------------------------------------------------------------------ WhatsApp helpers
  function escHtml(s) {
    return str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** Safe HTML that shows *bold*, _italic_, ~strike~ and line breaks the way WhatsApp will. */
  function formatPreview(text) {
    var s = escHtml(text);
    function pair(mark, tag) {
      var m = mark === "*" ? "\\*" : mark;
      var re = new RegExp("(^|[\\s(\\[\\u2066-\\u2069])" + m + "([^\\s" + m + "](?:[^" + m + "\\n]*[^\\s" + m + "])?)" + m + "(?![\\p{L}\\p{N}])", "gu");
      s = s.replace(re, function (all, pre, inner) { return pre + "<" + tag + ">" + inner + "</" + tag + ">"; });
    }
    pair("*", "b"); pair("_", "i"); pair("~", "s");
    return s.replace(/\n/g, "<br>");
  }

  function waDigits(d) { return str(d).replace(/\D/g, ""); }
  function waLink(digits, text) {
    var d = waDigits(digits);
    return "https://wa.me/" + d + (text != null && text !== "" ? "?text=" + encodeURIComponent(text) : "");
  }

  function copyText(text) {
    text = str(text);
    function legacy() {
      return new Promise(function (resolve) {
        try {
          var ta = document.createElement("textarea");
          ta.value = text; ta.setAttribute("readonly", "");
          ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
          document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
          var ok = document.execCommand("copy");
          document.body.removeChild(ta);
          resolve(!!ok);
        } catch (e) { resolve(false); }
      });
    }
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { return true; }, legacy);
      }
    } catch (e) { /* fall through */ }
    return legacy();
  }

  /** Quick sanity report for a rendered message (used by tests and the manual check). */
  function lintMessage(text) {
    text = str(text);
    var problems = [], leftovers = text.match(PH_RE) || [];
    text.split("\n").forEach(function (line, i) {
      ["*", "_", "~"].forEach(function (m) {
        var n = line.split(m).length - 1;
        if (n % 2) problems.push("line " + (i + 1) + ": unbalanced " + m);
      });
    });
    var iso1 = (text.match(/\u2068/g) || []).length, iso2 = (text.match(/\u2069/g) || []).length;
    if (iso1 !== iso2) problems.push("unbalanced bidi isolates");
    if (/\*\s|\s\*(?=\s|$)/.test(text.replace(/\*[^*\n]+\*/g, ""))) problems.push("a * marker touches whitespace");
    return { ok: !problems.length && !leftovers.length && text.length <= MAX_LEN, problems: problems, leftovers: leftovers, length: text.length, tooLong: text.length > MAX_LEN };
  }

  // ------------------------------------------------------------------ editor text helpers (pure)
  function insertAt(value, start, end, text) {
    var v = value.slice(0, start) + text + value.slice(end), caret = start + text.length;
    return { value: v, start: caret, end: caret };
  }

  /** Wrap the selection in a WhatsApp marker ("*" bold, "_" italic); toggles when already wrapped. */
  function wrapSelection(value, start, end, marker) {
    var sel = value.slice(start, end);
    if (!sel.trim()) {
      var v0 = value.slice(0, start) + marker + marker + value.slice(end);
      return { value: v0, start: start + 1, end: start + 1 };
    }
    // selection includes its own markers -> unwrap
    if (sel.length >= 2 && sel.charAt(0) === marker && sel.charAt(sel.length - 1) === marker) {
      var inner = sel.slice(1, -1);
      return { value: value.slice(0, start) + inner + value.slice(end), start: start, end: start + inner.length };
    }
    // markers right outside the selection -> unwrap
    if (value.charAt(start - 1) === marker && value.charAt(end) === marker) {
      return { value: value.slice(0, start - 1) + sel + value.slice(end + 1), start: start - 1, end: end - 1 };
    }
    var lead = /^\s*/.exec(sel)[0], trail = /\s*$/.exec(sel)[0];
    var core = sel.slice(lead.length, sel.length - trail.length);
    var rep = lead + marker + core + marker + trail;
    return { value: value.slice(0, start) + rep + value.slice(end), start: start + lead.length, end: start + lead.length + core.length + 2 };
  }

  // ------------------------------------------------------------------ sample data (editor preview)
  function makeSample(now) {
    now = now || new Date();
    var G = "programming/baccalaureate/grade-2-secondary/";
    var CUR = G + "chapter-2-lesson-2-functions", REV = G + "chapter-2-lesson-1-variables";
    var today = ymdString(cairoParts(now));
    function plus(n) { var x = new Date((dayNumber(today) + n) * 86400000); return x.getUTCFullYear() + "-" + ("0" + (x.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + x.getUTCDate()).slice(-2); }
    var facts = {}; facts[CUR] = { attendance: "online", watch_pct: 42, can_watch: true };
    facts[REV] = { quiz: { taken: true, score: 9, total: 10 }, homework: { submitted: false } };
    var lessons = {};
    lessons[CUR] = { has_video: true, has_quiz: true, has_assignment: true };
    lessons[REV] = { has_video: true, has_quiz: true, has_assignment: true };
    return {
      student: { name: "مريم أحمد", phone: "01012345678", parent_phone: "01234567890" },
      group: { group: "سبت 6 م", settings: { current_lesson: CUR, review_lessons: [REV], note: "", parents_contacted: true } },
      lessons: lessons, facts: facts, now: now,
      deadlines: { watch: plus(1), hw: plus(2), nextSession: plus(3) + "T18:00:00+03:00" },
      verdicts: {
        session: { lesson: CUR, state: "session_unfinished" },
        homework: [{ lesson: REV, state: "homework_missing" }],
        quiz: [{ lesson: REV, state: "quiz_absent" }]
      }
    };
  }

  // ------------------------------------------------------------------ editor
  var EMOJIS = ["👋", "🌷", "🌟", "✅", "⚠️", "📚", "📝", "❓", "🎯", "💬", "⏰", "📣", "🙏", "👏", "▶️", "💻", "📌", "📊", "🔒", "🔓"];

  function placeholdersFor(key) {
    var k = str(key).replace(/^line_/, "");
    var base = ["student_name", "student_first_name", "lesson", "lesson_current", "lesson_review", "group"];
    var extra = [];
    if (/^session_/.test(k)) extra = ["watch_pct", "watch_deadline", "deadline_when", "watch_list"];
    else if (/^homework_/.test(k)) extra = ["deadline_when", "hw_deadline"];
    else if (/^quiz_(mark|praise)/.test(k)) extra = ["score", "total", "quiz_pct"];
    else if (k === "combined") extra = ["issues", "watch_pct", "hw_deadline", "watch_deadline"];
    else if (k === "group_reminder") { base = ["group", "lesson_current", "lesson_review"]; extra = ["hw_list", "watch_list", "parents_contacted_line", "deadline_when", "hw_deadline", "watch_deadline", "session_when", "group_note"]; }
    else if (k === "monthly_review") { base = ["student_name", "student_first_name", "group"]; extra = ["month_label", "quiz_line", "homework_line", "attendance_line", "watch_line", "missed_line", "review_lines"]; }
    else if (k === "header") { base = ["student_name", "group"]; extra = []; }
    return base.concat(extra);
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (a) {
      if (a === "class") n.className = attrs[a];
      else if (a === "text") n.textContent = attrs[a];
      else if (a === "html") n.innerHTML = attrs[a];
      else n.setAttribute(a, attrs[a]);
    });
    (kids || []).forEach(function (k) { if (k != null) n.appendChild(typeof k === "string" ? document.createTextNode(k) : k); });
    return n;
  }

  /**
   * mountEditor(container, { templates, defaults, sample, onSave, labels })
   *   templates : saved overrides { key: body }
   *   defaults  : defaults (falls back to DEFAULTS)
   *   sample    : data for the live preview (falls back to makeSample())
   *   onSave    : function(changes) -> void | Promise.  changes = { key: body | null }, only the
   *               keys that changed; null = reset to the built-in default.
   * Returns { destroy(), getChanges(), setTemplates(t) }.
   */
  function mountEditor(container, opts) {
    opts = opts || {};
    var defaults = opts.defaults || DEFAULTS;
    var saved = Object.assign({}, opts.templates || {});
    var sample = opts.sample || makeSample();
    var labels = Object.assign({}, LABELS, opts.labels || {});
    var keys = ORDER.filter(function (k) { return defaults[k] != null; });
    Object.keys(defaults).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    var drafts = {};     // key -> body currently in the box (only when it differs from the saved/base body)
    var current = keys[0];
    var busy = false;

    function baseBody(k) { return bodyFor(k, saved).replace(/\r\n?/g, "\n"); }
    function bodyOf(k) { return hasOwn(drafts, k) ? drafts[k] : baseBody(k); }
    function isDirty(k) { return hasOwn(drafts, k) && drafts[k] !== baseBody(k); }
    function anyDirty() { return keys.some(isDirty); }

    container.innerHTML = "";
    container.classList.add("ft-editor");
    container.setAttribute("dir", "rtl");

    var tabs = el("div", { class: "ft-tabs", role: "tablist", "aria-label": "القوالب" });
    var ta = el("textarea", { class: "ft-ta", dir: "auto", rows: "9", id: "ft-ta-" + Math.random().toString(36).slice(2, 7), spellcheck: "false" });
    var btnB = el("button", { type: "button", class: "ft-tool", "aria-label": "خط عريض" }, [el("b", { text: "B" }), " عريض"]);
    var btnI = el("button", { type: "button", class: "ft-tool", "aria-label": "خط مائل" }, [el("i", { text: "I" }), " مائل"]);
    var btnE = el("button", { type: "button", class: "ft-tool", "aria-label": "إيموجي", "aria-expanded": "false" }, ["😀 إيموجي"]);
    var emojiBox = el("div", { class: "ft-emojis", hidden: "" });
    var chips = el("div", { class: "ft-chips" });
    var previewTitle = el("h3", { class: "ft-h" });
    var bubble = el("div", { class: "ft-bubble", dir: "auto" });
    var info = el("div", { class: "ft-info", "aria-live": "polite" });
    var btnSave = el("button", { type: "button", class: "ft-btn primary" }, ["حفظ"]);
    var btnReset = el("button", { type: "button", class: "ft-btn" }, ["رجوع للأصلي"]);
    var status = el("div", { class: "ft-status", "aria-live": "polite" });

    container.appendChild(tabs);
    container.appendChild(el("label", { class: "ft-h", for: ta.id, text: "نص القالب" }));
    container.appendChild(ta);
    container.appendChild(el("div", { class: "ft-tools" }, [btnB, btnI, btnE]));
    container.appendChild(emojiBox);
    container.appendChild(el("h3", { class: "ft-h", text: "المتغيرات — اضغط للإضافة" }));
    container.appendChild(chips);
    container.appendChild(previewTitle);
    container.appendChild(bubble);
    container.appendChild(info);
    container.appendChild(el("div", { class: "ft-actions" }, [btnSave, btnReset]));
    container.appendChild(status);

    EMOJIS.forEach(function (e) {
      var b = el("button", { type: "button", class: "ft-emoji", text: e, "aria-label": e });
      b.addEventListener("click", function () { edit(insertAt(ta.value, ta.selectionStart, ta.selectionEnd, e)); });
      emojiBox.appendChild(b);
    });

    function keep(e) { e.preventDefault(); }   // don't steal focus/selection from the textarea
    [btnB, btnI, btnE].forEach(function (b) { b.addEventListener("mousedown", keep); });
    btnB.addEventListener("click", function () { edit(wrapSelection(ta.value, ta.selectionStart, ta.selectionEnd, "*")); });
    btnI.addEventListener("click", function () { edit(wrapSelection(ta.value, ta.selectionStart, ta.selectionEnd, "_")); });
    btnE.addEventListener("click", function () {
      var open = emojiBox.hasAttribute("hidden");
      if (open) emojiBox.removeAttribute("hidden"); else emojiBox.setAttribute("hidden", "");
      btnE.setAttribute("aria-expanded", open ? "true" : "false");
    });

    function edit(r) {
      ta.value = r.value;
      ta.focus();
      try { ta.setSelectionRange(r.start, r.end); } catch (e) { /* ignore */ }
      onInput();
    }

    function onInput() {
      var v = ta.value.replace(/\r\n?/g, "\n");
      if (v === baseBody(current)) delete drafts[current]; else drafts[current] = v;
      refresh(false);
    }
    ta.addEventListener("input", onInput);

    function buildTabs() {
      tabs.innerHTML = "";
      keys.forEach(function (k) {
        var b = el("button", { type: "button", class: "ft-tab" + (k === current ? " on" : "") + (isDirty(k) ? " dirty" : ""), role: "tab", "aria-selected": k === current ? "true" : "false", "data-key": k }, [labels[k] || k]);
        b.addEventListener("click", function () { current = k; ta.value = bodyOf(k); refresh(true); });
        tabs.appendChild(b);
      });
    }

    function buildChips() {
      chips.innerHTML = "";
      placeholdersFor(current).forEach(function (p) {
        if (!hasOwn(PLACEHOLDERS, p)) return;
        var b = el("button", { type: "button", class: "ft-chip", title: PLACEHOLDERS[p].ar + " — " + PLACEHOLDERS[p].en, "data-ph": p }, ["{" + p + "}"]);
        b.addEventListener("mousedown", keep);
        b.addEventListener("click", function () { edit(insertAt(ta.value, ta.selectionStart, ta.selectionEnd, "{" + p + "}")); });
        chips.appendChild(b);
      });
      if (current !== "header") {
        var h = el("button", { type: "button", class: "ft-chip", title: "الترويسة المشتركة", "data-ph": "H" }, ["{H}"]);
        h.addEventListener("mousedown", keep);
        h.addEventListener("click", function () { edit(insertAt(ta.value, ta.selectionStart, ta.selectionEnd, "{H}")); });
        chips.appendChild(h);
      }
    }

    function previewText() {
      var k = current, body = bodyOf(k), tpl = {};
      keys.forEach(function (x) { tpl[x] = bodyOf(x); });
      if (k === "header" || /^line_/.test(k)) {
        var kind = k === "header" ? "session_unfinished" : k.replace(/^line_/, "");
        var ctxIn = Object.assign({}, sample, { kind: kind });
        var c = buildContext(ctxIn); buildLists(ctxIn, c, true);
        if (k === "header") { var r = render(body, c, { header: body }); return { text: r.text, missing: r.missing, trimmed: false }; }
        var r2 = render(body, c); return { text: r2.text, missing: r2.missing, trimmed: false };
      }
      return composeFull(sample, k, Object.assign({}, sample, { templates: tpl }));
    }

    function refresh(full) {
      if (full) { buildChips(); }
      buildTabs();
      var pv = previewText();
      previewTitle.textContent = "معاينة (" + str(sample.student && sample.student.name) + ")";
      bubble.innerHTML = formatPreview(pv.text);
      var lint = lintMessage(pv.text), notes = [];
      notes.push(pv.text.length + " / " + MAX_LEN + " حرف");
      if (pv.missing && pv.missing.length) notes.push("⚠️ متغيرات غير معروفة: " + pv.missing.map(function (m) { return "{" + m + "}"; }).join(" "));
      if (pv.trimmed) notes.push("⚠️ الرسالة طويلة وتم اختصارها");
      if (lint.problems.length) notes.push("⚠️ تحقق من علامات التنسيق *");
      info.textContent = notes.join("  ·  ");
      info.classList.toggle("warn", notes.length > 1);
      btnSave.disabled = busy || !anyDirty();
      btnReset.disabled = busy || bodyOf(current) === str(defaults[current]).replace(/\r\n?/g, "\n");
    }

    btnReset.addEventListener("click", function () {
      var d = str(defaults[current]).replace(/\r\n?/g, "\n");
      ta.value = d;
      if (d === baseBody(current)) delete drafts[current]; else drafts[current] = d;
      status.textContent = "";
      refresh(false);
    });

    function getChanges() {
      var out = {};
      keys.forEach(function (k) {
        if (!isDirty(k)) return;
        var body = drafts[k];
        out[k] = (body.trim() === "" || body === str(defaults[k]).replace(/\r\n?/g, "\n")) ? null : body;
      });
      return out;
    }

    btnSave.addEventListener("click", function () {
      var changes = getChanges();
      if (!Object.keys(changes).length) return;
      busy = true; status.className = "ft-status"; status.textContent = "جارٍ الحفظ…"; refresh(false);
      var res;
      try { res = opts.onSave ? opts.onSave(changes) : null; } catch (e) { res = Promise.reject(e); }
      Promise.resolve(res).then(function () {
        Object.keys(changes).forEach(function (k) { if (changes[k] == null) delete saved[k]; else saved[k] = changes[k]; });
        drafts = {};
        busy = false; status.className = "ft-status ok"; status.textContent = "تم الحفظ ✓";
        ta.value = bodyOf(current); refresh(false);
      }, function (err) {
        busy = false; status.className = "ft-status err";
        status.textContent = "تعذّر الحفظ: " + str(err && err.message ? err.message : err);
        refresh(false);
      });
    });

    ta.value = bodyOf(current);
    refresh(true);

    return {
      getChanges: getChanges,
      setTemplates: function (t) { saved = Object.assign({}, t || {}); drafts = {}; ta.value = bodyOf(current); refresh(true); },
      destroy: function () { container.innerHTML = ""; container.classList.remove("ft-editor"); }
    };
  }

  return {
    VERSION: VERSION, MAX_LEN: MAX_LEN, FSI: FSI, PDI: PDI,
    DEFAULTS: DEFAULTS, PLACEHOLDERS: PLACEHOLDERS, LABELS: LABELS, ORDER: ORDER, LIST_ITEMS: LIST_ITEMS,
    buildContext: buildContext, render: render, compose: compose, composeFull: composeFull, composeMonthly: composeMonthly, monthLabel: monthLabel,
    deriveIssues: deriveIssues, templateForState: templateForState,
    formatPreview: formatPreview, waLink: waLink, waDigits: waDigits, copyText: copyText, lintMessage: lintMessage,
    deadlineWhen: deadlineWhen, sessionWhen: sessionWhen, prettyLesson: prettyLesson, setLessonTitles: setLessonTitles, lessonSlug: lessonSlug,
    insertAt: insertAt, wrapSelection: wrapSelection, placeholdersFor: placeholdersFor,
    makeSample: makeSample, mountEditor: mountEditor
  };
});
