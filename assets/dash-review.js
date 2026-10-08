/* ==========================================================================
   dash-review.js — shared by dashboard/student.html and dashboard/master.html

   Turns quiz attempts + graded assignments into one tree:

       Chapter  ->  Lesson  ->  Quiz / Assignment  ->  Question

   and renders it. Read-only presentation: it never writes anything and never
   talks to the backend — both pages hand it the rows they already fetched.

   Usage:
     var R = DashReview.create({ el, fmtWhen, whenMs, isTruthyFlag });
     R.registerLessons(quizRows);
     var tree = R.buildTree(quizRows, subRows);
     node.appendChild(R.renderChapters(tree, { mode: "student" | "master" }));
   ========================================================================== */
(function () {
  "use strict";

  var SUBJECTS = { programming: "Programming", english: "English", math: "Math" };

  function create(h) {
    var el = h.el;
    var fmtWhen = h.fmtWhen || String;
    var whenMs = h.whenMs || function () { return NaN; };
    var truthy = h.isTruthyFlag || function (v) { return v === true || String(v).toUpperCase() === "TRUE"; };
    // Wording. Pass h.t to translate any of these (the student page does, in Arabic); master keeps English.
    var T = {
      chapter: "Chapter", lesson: "Lesson", quiz: "Quiz", assign: "Assignment", other: "Other lessons", subjects: SUBJECTS,
      srcQuiz: "Quiz", srcAssign: "Assignment",
      srcHead: function (w, a, mode) { return w ? plural(w, "question") + (mode === "master" ? " missed" : " to review") + " \u00b7 from " + plural(a, "attempt") : plural(a, "attempt") + (mode === "master" ? " \u00b7 no misses" : " \u00b7 nothing to review"); },
      noMistakes: function (mode) { return mode === "master" ? "No missed questions in this view." : "No mistakes here \u2014 nice work."; },
      chip: function (n, mode) { return n ? n + (mode === "master" ? " missed" : " to review") : (mode === "master" ? "No misses" : "All clear"); },
      lastMissed: "Last missed ", yourAnswer: "Your answer", correctAnswer: "Correct answer",
      missedTimes: function (n) { return "Missed " + n + " times"; },
      quizPct: function (p) { return "Quiz " + p + "%"; }, assignScore: function (c, t) { return "Assignment " + c + "/" + t; },
      meterTitle: function (c, t) { return c + " of " + t + " quiz answers correct"; },
      assignOnly: "Assignments only", noChapter: "no chapter", lessons: function (n) { return plural(n, "lesson"); }
    };
    Object.keys(h.t || {}).forEach(function (k) { T[k] = h.t[k]; });

    // ---- Names ------------------------------------------------------------

    function subjectName(s) {
      s = String(s || "");
      return T.subjects[s.toLowerCase()] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
    }

    function sentence(s) {
      s = String(s || "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
      return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    // "Chapter 1 Lesson 2 \u2013 Information Ethics Quiz" -> { chapter:"1", num:"2", name:"Information Ethics" }
    // "Lesson 2 - How AI works Quiz"                      -> { chapter:"",  num:"2", name:"How AI works" }
    function parseTitle(raw) {
      var t = String(raw || "").replace(/\s*(quiz|assignment)\s*$/i, "").trim();
      var out = { name: t, num: "", chapter: "" };
      var m = t.match(/^chap(?:t)?er\s*(\d+)\s*[,:\u2013\u2014-]?\s*lesson\s*(\d+)\s*[,:\u2013\u2014-]*\s*(.+)$/i);
      if (m) { out.chapter = m[1]; out.num = m[2]; out.name = m[3].trim(); return out; }
      m = t.match(/^lesson\s*(\d+)\s*[,:\u2013\u2014-]+\s*(.+)$/i);
      if (m) { out.num = m[1]; out.name = m[2].trim(); }
      return out;
    }

    // Folder slug fallback: "chapter-2-lesson-1-personal-information". The
    // site has one folder spelled "chaper-1-...", so the regex allows it.
    function parseSlug(slug) {
      var s = String(slug || "");
      var m = s.match(/^(?:chap(?:t)?er-(\d+)-)?(?:lesson-(\d+)-)?(.+)$/i);
      return m ? { name: sentence(m[3]), num: m[2] || "", chapter: m[1] || "" } : { name: sentence(s), num: "", chapter: "" };
    }

    var registry = {};
    // The quiz's own title is the best human name for a lesson. Assignment
    // rows only carry the folder slug, so they borrow the name from here.
    function registerLessons(quizRows) {
      (quizRows || []).forEach(function (r) {
        if (r && r.lesson && r.quiz_title && !registry[r.lesson]) {
          var p = parseTitle(r.quiz_title);
          var fromSlug = parseSlug(r.lesson);
          registry[r.lesson] = {
            name: p.name || fromSlug.name,
            num: p.num || fromSlug.num,
            chapter: p.chapter || fromSlug.chapter,
          };
        }
      });
    }

    function lessonInfo(slug) {
      return registry[slug] || parseSlug(slug);
    }

    function lessonLabel(slug) {
      var i = lessonInfo(slug);
      return (i.num ? T.lesson + " " + i.num + " \u00b7 " : "") + i.name;
    }

    function chapterOf(tagged, slug) {
      if (tagged !== undefined && tagged !== null && String(tagged) !== "") return String(tagged);
      return lessonInfo(slug).chapter || "";
    }

    // ---- Parsing ----------------------------------------------------------

    function parseList(str) {
      try {
        var v = JSON.parse(str || "[]");
        return Array.isArray(v) ? v : [];
      } catch (e) { return []; }
    }

    function splitMatch(question, type) {
      var out = { text: question, instr: "" };
      if (type === "match") {
        var i = String(question).lastIndexOf(" \u2014 ");
        if (i > 0) { out.instr = question.slice(0, i); out.text = question.slice(i + 3); }
      }
      return out;
    }

    function cleanAns(v, type) {
      var t = (v === undefined || v === null || v === "") ? "\u2014" : String(v);
      return type === "match" ? t.split("; ").join("\n") : t;
    }

    // ---- Tree -------------------------------------------------------------

    function newLesson(slug, subject, group) {
      var info = lessonInfo(slug);
      return {
        slug: slug, name: info.name, num: info.num, subject: subject || "", group: group || "",
        quiz: { correct: 0, total: 0, attempts: 0, seen: {} },
        assign: { correct: 0, total: 0, attempts: 0, seen: {} },
        items: { quiz: {}, assign: {} },
      };
    }

    function touch(L, source, rowKey) {
      var s = L[source];
      if (!s.seen[rowKey]) { s.seen[rowKey] = true; s.attempts += 1; }
    }

    function record(L, source, q, ctx) {
      var side = L[source];
      var ok = truthy(q.ok);
      side.total += 1;
      if (ok) side.correct += 1;
      var key = String(q.question || "");
      var it = L.items[source][key];
      if (!it) {
        var sp = splitMatch(q.question || "(untitled question)", q.type);
        it = L.items[source][key] = {
          text: sp.text, instr: sp.instr, type: q.type || "", total: 0, wrong: 0, correct: "",
          lastAnswer: "", lastWhen: "", lastMs: -1, answers: {}, students: {},
        };
      }
      it.total += 1;
      if (q.correct !== undefined && q.correct !== null && q.correct !== "") it.correct = q.correct;
      if (!ok) {
        it.wrong += 1;
        var a = cleanAns(q.chosen, q.type);
        it.answers[a] = (it.answers[a] || 0) + 1;
        if (ctx.student) it.students[ctx.student] = true;
        var ms = whenMs(ctx.when);
        var stamp = isNaN(ms) ? 0 : ms;
        if (stamp >= it.lastMs) { it.lastMs = stamp; it.lastAnswer = a; it.lastWhen = ctx.when; }
      }
    }

    // opts.groupOf(row) may return a label (e.g. "Senior 2") that keeps
    // same-numbered chapters of different courses apart. Student view: none.
    function buildTree(quizRows, subRows, opts) {
      var groupOf = (opts && opts.groupOf) || function () { return ""; };
      var chapters = {};
      function lessonNode(group, chKey, slug, subject) {
        var id = group + "\u0001" + chKey;
        var c = chapters[id];
        if (!c) c = chapters[id] = { key: chKey, group: group, lessons: {}, order: [] };
        var L = c.lessons[slug];
        if (!L) { L = c.lessons[slug] = newLesson(slug, subject, group); c.order.push(slug); }
        return L;
      }

      (quizRows || []).forEach(function (row, idx) {
        var slug = row.lesson || row.quiz_title || "";
        var ctx = { when: row.start_time || row.date || "", student: row.name || "" };
        var rowKey = "q" + idx;
        parseList(row.questions_json).forEach(function (q) {
          var L = lessonNode(groupOf(row), chapterOf(q.chapter, slug), slug, row.subject);
          touch(L, "quiz", rowKey);
          record(L, "quiz", {
            question: q.question, chosen: q.your_answer, correct: q.correct_answer,
            ok: q.is_correct !== undefined ? q.is_correct : false, type: q.type,
          }, ctx);
        });
      });

      (subRows || []).forEach(function (row, idx) {
        if (!row.answers_json) return; // only graded assignments carry per-question detail
        var slug = row.lesson || "";
        var ctx = { when: row.submitted_time || row.date || "", student: row.name || "" };
        var rowKey = "s" + idx;
        parseList(row.answers_json).forEach(function (a) {
          var L = lessonNode(groupOf(row), chapterOf(a.chapter, slug), slug, row.subject);
          touch(L, "assign", rowKey);
          record(L, "assign", {
            question: a.prompt, chosen: a.chosen, correct: a.correct_answer,
            ok: a.is_correct !== undefined ? a.is_correct : false, type: a.type,
          }, ctx);
        });
      });

      var list = Object.keys(chapters).map(function (k) {
        var c = chapters[k];
        var lessons = c.order.map(function (s) { return c.lessons[s]; });
        lessons.sort(function (a, b) {
          var an = a.num === "" ? Infinity : Number(a.num), bn = b.num === "" ? Infinity : Number(b.num);
          if (an !== bn) return an - bn;
          return String(a.name).localeCompare(String(b.name));
        });
        var node = { key: c.key, group: c.group, lessons: lessons, quizCorrect: 0, quizTotal: 0, toReview: 0 };
        lessons.forEach(function (L) {
          node.quizCorrect += L.quiz.correct;
          node.quizTotal += L.quiz.total;
          L.toReview = 0;
          ["quiz", "assign"].forEach(function (src) {
            var n = 0;
            Object.keys(L.items[src]).forEach(function (q) { if (L.items[src][q].wrong > 0) n += 1; });
            L[src].toReview = n;
            L.toReview += n;
          });
          node.toReview += L.toReview;
        });
        return node;
      });
      list.sort(function (a, b) {
        // Chapter-less lessons (English, Math, loose Programming) go last.
        var ak = a.key === "" ? 1 : 0, bk = b.key === "" ? 1 : 0;
        if (ak !== bk) return ak - bk;
        if (a.group !== b.group) return String(a.group).localeCompare(String(b.group));
        var an = a.key === "" ? Infinity : Number(a.key), bn = b.key === "" ? Infinity : Number(b.key);
        if (isNaN(an) && isNaN(bn)) return String(a.key).localeCompare(String(b.key));
        if (isNaN(an)) return 1;
        if (isNaN(bn)) return -1;
        return an - bn;
      });
      return list;
    }

    function totalToReview(tree) {
      return tree.reduce(function (n, c) { return n + c.toReview; }, 0);
    }

    // ---- Rendering --------------------------------------------------------

    function pct(c, t) { return t ? Math.round((c / t) * 100) : null; }
    function tone(p) { return p === null ? "" : (p >= 80 ? "is-good" : (p < 50 ? "is-low" : "is-mid")); }
    function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
    function chapterTitle(c) {
      if (c.key !== "") return T.chapter + " " + c.key;
      return subjectName(c.lessons[0] && c.lessons[0].subject) || T.other;
    }

    function chip(cls, text) { return el("span", { class: "d-chip " + cls }, [text]); }
    function reviewChip(n, mode) {
      return n ? chip("bad", T.chip(n, mode)) : chip("good", T.chip(0, mode));
    }

    function whereLine(L, chKey, source, extra) {
      // The lesson header above the card already carries the full lesson
      // name, so the location line only repeats its number (or the name for
      // lessons that have no number).
      var parts = [subjectName(L.subject), L.group, chKey === "" ? "" : T.chapter + " " + chKey, L.num ? T.lesson + " " + L.num : "", source === "quiz" ? T.quiz : T.assign]
        .filter(Boolean);
      var kids = [];
      parts.forEach(function (p, i) {
        if (i) kids.push(el("i", { "aria-hidden": "true" }));
        kids.push(el("span", {}, [p]));
      });
      if (extra) kids.push(el("span", { class: "q-when" }, [extra]));
      return el("div", { class: "q-where" }, kids);
    }

    function topAnswer(answers) {
      var best = "", n = 0;
      Object.keys(answers).forEach(function (a) { if (answers[a] > n) { best = a; n = answers[a]; } });
      return { text: best, n: n };
    }

    function answerRow(kind, label, text) {
      return el("div", { class: "q-ans " + kind }, [
        el("span", {}, [label]),
        el("span", { dir: "auto" }, [text]),
      ]);
    }

    function questionCard(L, chKey, source, it, mode) {
      var card = el("div", { class: "q-card" });
      var when = it.lastWhen ? (mode === "master" ? "Latest " : T.lastMissed) + fmtWhen(it.lastWhen) : "";
      card.appendChild(whereLine(L, chKey, source, when));
      if (it.instr) card.appendChild(el("p", { class: "q-instr", dir: "auto" }, [it.instr]));
      card.appendChild(el("p", { class: "q-text", dir: "auto" }, [it.text]));
      if (mode === "master") {
        var top = topAnswer(it.answers);
        card.appendChild(answerRow("is-your", top.n > 1 ? "Common mistake" : "Wrong answer", top.text || "\u2014"));
      } else {
        card.appendChild(answerRow("is-your", T.yourAnswer, it.lastAnswer || "\u2014"));
      }
      card.appendChild(answerRow("is-right", T.correctAnswer, cleanAns(it.correct, it.type)));
      var foot = el("div", { class: "q-foot" });
      if (mode === "master") {
        foot.appendChild(chip("bad", "Missed " + it.wrong + " of " + plural(it.total, "attempt")));
        var ns = Object.keys(it.students).length;
        if (ns) foot.appendChild(chip("", plural(ns, "student")));
      } else if (it.wrong > 1) {
        foot.appendChild(chip("bad", T.missedTimes(it.wrong)));
      }
      if (foot.childNodes.length) card.appendChild(foot);
      return card;
    }

    function sourceBlock(L, chKey, source, mode) {
      var side = L[source];
      if (!side.total) return null;
      var wrongItems = Object.keys(L.items[source]).map(function (k) { return L.items[source][k]; })
        .filter(function (it) { return it.wrong > 0; })
        .sort(function (a, b) { return b.wrong - a.wrong || b.lastMs - a.lastMs; });
      var label = source === "quiz" ? T.srcQuiz : T.srcAssign;
      var head = el("div", { class: "rv-src-head" }, [
        chip(source === "quiz" ? "quiz" : "assign", label),
        el("span", {}, [T.srcHead(wrongItems.length, side.attempts, mode)]),
      ]);
      var box = el("div", { class: "rv-src" }, [head]);
      if (!wrongItems.length) {
        box.appendChild(el("div", { class: "rv-empty" }, [T.noMistakes(mode)]));
      } else {
        wrongItems.forEach(function (it) { box.appendChild(questionCard(L, chKey, source, it, mode)); });
      }
      return box;
    }

    function lessonBlock(L, chKey, mode, open) {
      var qp = pct(L.quiz.correct, L.quiz.total);
      var meta = el("div", { class: "rv-ls-meta" });
      if (qp !== null) meta.appendChild(chip("quiz", T.quizPct(qp)));
      if (L.assign.total) meta.appendChild(chip("assign", T.assignScore(L.assign.correct, L.assign.total)));
      meta.appendChild(reviewChip(L.toReview, mode));

      var nameKids = [];
      if (L.num) nameKids.push(el("span", { class: "rv-ls-num" }, [T.lesson + " " + L.num]));
      nameKids.push(el("b", { dir: "auto" }, [L.name]));

      var attrs = { class: "rv-lesson" };
      if (open) attrs.open = "open";
      var det = el("details", attrs, [
        el("summary", {}, [el("div", { class: "rv-ls-head" }, [el("div", { class: "rv-ls-name" }, nameKids), meta])]),
      ]);
      var body = el("div", { class: "rv-ls-body" });
      ["quiz", "assign"].forEach(function (src) {
        var b = sourceBlock(L, chKey, src, mode);
        if (b) body.appendChild(b);
      });
      det.appendChild(body);
      return det;
    }

    function chapterBlock(c, mode, open) {
      var p = pct(c.quizCorrect, c.quizTotal);
      var stats = el("div", { class: "rv-ch-stats" });
      if (p !== null) {
        stats.appendChild(el("div", { class: "rv-meter", title: T.meterTitle(c.quizCorrect, c.quizTotal) }, [
          el("div", { class: "dash-bar" }, [el("div", { class: "dash-bar-fill " + tone(p), style: "width:" + Math.max(3, p) + "%" })]),
          el("strong", { class: tone(p) }, [p + "%"]),
        ]));
      } else {
        stats.appendChild(el("span", { class: "rv-sub", style: "color:var(--d-ink-3);font-size:13px;font-weight:600" }, [T.assignOnly]));
      }
      stats.appendChild(reviewChip(c.toReview, mode));

      var titleKids = [
        el("span", { class: "rv-caret", "aria-hidden": "true" }),
        el("b", {}, [chapterTitle(c)]),
        el("span", { class: "rv-sub" }, [[c.group, T.lessons(c.lessons.length), c.key === "" ? T.noChapter : ""].filter(Boolean).join(" \u00b7 ")]),
      ];
      var attrs = { class: "rv-chapter" };
      if (open) attrs.open = "open";
      var det = el("details", attrs, [
        el("summary", {}, [el("div", { class: "rv-ch-head" }, [el("div", { class: "rv-ch-title" }, titleKids), stats])]),
      ]);
      var withMisses = c.lessons.filter(function (L) { return L.toReview > 0; });
      var body = el("div", { class: "rv-ch-body" });
      c.lessons.forEach(function (L) {
        body.appendChild(lessonBlock(L, c.key, mode, withMisses.length === 1 && L.toReview > 0));
      });
      det.appendChild(body);
      return det;
    }

    function renderChapters(tree, opts) {
      opts = opts || {};
      var mode = opts.mode === "master" ? "master" : "student";
      var frag = el("div", { class: "rv-tree" });
      var opened = false;
      tree.forEach(function (c) {
        var open = !opened && c.toReview > 0;
        if (open) opened = true;
        frag.appendChild(chapterBlock(c, mode, open));
      });
      return frag;
    }

    // One question inside a single attempt's detail panel. The attempt row
    // above it already says which quiz and when, so no location line here.
    function attemptQuestion(q) {
      var sp = splitMatch(q.question, q.type);
      var ok = !!q.ok;
      var card = el("div", { class: "q-card" + (ok ? " is-ok" : "") });
      if (q.chapter) card.appendChild(el("div", { class: "q-where" }, [el("span", {}, [T.chapter + " " + q.chapter])]));
      if (sp.instr && !q.suppressInstr) card.appendChild(el("p", { class: "q-instr", dir: "auto" }, [sp.instr]));
      card.appendChild(el("p", { class: "q-text", dir: "auto" }, [q.label || sp.text]));
      if (!ok) {
        card.appendChild(answerRow("is-your", T.yourAnswer, cleanAns(q.chosen, q.type)));
        card.appendChild(answerRow("is-right", T.correctAnswer, cleanAns(q.correct, q.type)));
      } else {
        card.appendChild(answerRow("is-right", T.yourAnswer, cleanAns(q.chosen, q.type)));
      }
      return card;
    }

    return {
      registerLessons: registerLessons,
      lessonInfo: lessonInfo,
      lessonLabel: lessonLabel,
      subjectName: subjectName,
      chapterOf: chapterOf,
      buildTree: buildTree,
      totalToReview: totalToReview,
      renderChapters: renderChapters,
      attemptQuestion: attemptQuestion,
      chip: chip,
    };
  }

  window.DashReview = { create: create };
})();