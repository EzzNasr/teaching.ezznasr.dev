/* ==========================================================================
   bulk-parse.js — the Quiz Maker's bulk-paste question format, in the browser (Phase 2.5 step G).

   A line-for-line port of parse_bulk_graded_questions() and _split_option_marker() in
   tools/quiz-maker-v2/modules/common.py, so a block pasted on the teacher's page «دروسي»
   (dashboard/my-lessons.html) gives exactly the questions the desktop Quiz Maker would make.
   tests/test_p25_bulk_parse.js runs both on the same blocks and compares them.

     BulkParse.parse(text, chapter)  -> [question, ...]   (chapter: number or null)
     BulkParse.instructions(lesson)  -> the format, as text to copy to an AI agent

   Written questions keep model_answer here; the page sends it to the WrittenModels tab, never in the quiz.
   ========================================================================== */
(function (root) {
  "use strict";

  function splitOptionMarker(text) {
    var s = String(text).replace(/\s+$/, "");
    var closer = null, last = null, i = 0, n = s.length;
    while (i < n) {
      var c = s.charAt(i);
      if (c === "\\" && i + 1 < n) {
        var d = s.charAt(i + 1);
        if (closer === null && (d === "(" || d === "[")) { closer = d === "(" ? ")" : "]"; last = [i, "open", false]; }
        else if (closer !== null && d === closer) { closer = null; last = [i, "close", true]; }
        else last = [i, d === "*" ? "escstar" : "other", closer !== null];
        i += 2;
        continue;
      }
      last = [i, c === "*" ? "star" : "other", closer !== null];
      i += 1;
    }
    if (last === null) return [s.trim(), false];
    if (last[2]) return [s.trim(), false];
    if (last[1] === "star") return [s.slice(0, last[0]).trim(), true];
    if (last[1] === "escstar") return [(s.slice(0, last[0]) + "*").trim(), false];
    return [s.trim(), false];
  }

  function newWrittenQid() {
    var h = "";
    for (var i = 0; i < 8; i++) h += Math.floor(Math.random() * 16).toString(16);
    return "w" + h;
  }

  function parse(text, currentChapter) {
    text = String(text == null ? "" : text).replace(/\r\n?/g, "\n").trim();
    if (!text) return [];
    var items = [], counter = 0, chapter = currentChapter == null ? null : currentChapter;
    var mode = null;
    var qText, options, correct, explain, tfText, tfCorrect, tfExplain, matchPrompt, matchRows, matchExplain;
    var wPrompt, wMarks, wModel, wExplain, wField;
    function reset() {
      qText = null; options = []; correct = []; explain = "";
      tfText = null; tfCorrect = null; tfExplain = "";
      matchPrompt = null; matchRows = []; matchExplain = "";
      wPrompt = null; wMarks = 1; wModel = ""; wExplain = ""; wField = "prompt";
    }
    reset();
    function nextId() { counter += 1; return "g" + counter; }
    function flush() {
      var item = null;
      if (mode === "written" && wPrompt) {
        item = { type: "written", qid: newWrittenQid(), prompt: wPrompt.trim(), max_marks: wMarks, model_answer: wModel.trim(), explain: wExplain.trim() };
      } else if (mode === "mcq" && qText && options.length >= 2) {
        item = { id: nextId(), type: "mcq", prompt: qText, options: options.slice(), correct: correct.length ? correct.slice() : [0], explain: explain };
      } else if (mode === "tf" && tfText && tfCorrect !== null) {
        item = { id: nextId(), type: "truefalse", prompt: tfText, correct: tfCorrect, explain: tfExplain };
      } else if (mode === "match" && matchPrompt && matchRows.length >= 2) {
        var seen = {}, pool = [];
        matchRows.forEach(function (r) { if (!seen[r.correct]) { seen[r.correct] = true; pool.push(r.correct); } });
        pool.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });   // Python sorted(): by code point
        item = { id: nextId(), type: "match", prompt: matchPrompt, rows: matchRows.slice(), options: pool, explain: matchExplain };
      }
      if (item !== null) {
        if (chapter !== null) item.chapter = chapter;
        items.push(item);
      }
    }

    var lines = text.split("\n");
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim(), m;
      if (!line) continue;

      if (/^-{3,}$/.test(line)) { flush(); mode = null; reset(); continue; }

      m = /^Ch:\s*(\d+)/i.exec(line);
      if (m) { flush(); mode = null; reset(); chapter = parseInt(m[1], 10); continue; }

      m = /^(WRITTEN|W):\s*(.*)$/i.exec(line);
      if (m) { flush(); mode = "written"; wPrompt = m[2].trim(); wMarks = 1; wModel = ""; wExplain = ""; wField = "prompt"; continue; }

      if (mode === "written") {
        m = /^(MARKS|MAX):\s*([0-9]+(?:\.[0-9]+)?)/i.exec(line);
        if (m) { var v = parseFloat(m[2]); wMarks = v > 0 && v <= 100 ? v : 1; continue; }
        m = /^MODEL:\s*(.*)$/i.exec(line);
        if (m) { wModel = m[1]; wField = "model"; continue; }
        if (line.indexOf("E:") === 0) { wExplain = line.slice(2).trim(); wField = "explain"; continue; }
        if (!/^(Q:|TF:|MATCH:|Ch:)/i.test(line)) {
          if (wField === "model") wModel += "\n" + line;
          else if (wField === "explain") wExplain += "\n" + line;
          else wPrompt += "\n" + line;
          continue;
        }
      }

      if (line.indexOf("Q:") === 0) { flush(); mode = "mcq"; qText = line.slice(2).trim(); options = []; correct = []; explain = ""; continue; }
      if (line.indexOf("TF:") === 0) { flush(); mode = "tf"; tfText = line.slice(3).trim(); tfCorrect = null; tfExplain = ""; continue; }
      if (line.toUpperCase().indexOf("MATCH:") === 0) {
        flush(); mode = "match"; matchPrompt = line.slice(line.indexOf(":") + 1).trim(); matchRows = []; matchExplain = ""; continue;
      }
      if (mode === "mcq" && /^[A-Fa-f]\)/.test(line)) {
        var o = splitOptionMarker(line.slice(2).trim());
        options.push(o[0]);
        if (o[1]) correct.push(options.length - 1);
        continue;
      }
      if (mode === "tf" && line.toLowerCase().indexOf("correct:") === 0) {
        tfCorrect = line.slice(line.indexOf(":") + 1).trim().toLowerCase().charAt(0) === "t";
        continue;
      }
      if (mode === "match" && line.charAt(0) === "-" && line.indexOf("->") !== -1) {
        var body = line.slice(1), k = body.indexOf("->");
        matchRows.push({ label: body.slice(0, k).trim(), correct: body.slice(k + 2).trim() });
        continue;
      }
      if (line.indexOf("E:") === 0) {
        var ex = line.slice(2).trim();
        if (mode === "mcq") explain = ex; else if (mode === "tf") tfExplain = ex; else if (mode === "match") matchExplain = ex;
        continue;
      }
    }
    flush();
    return items;
  }

  // The format, written for an AI agent (or a person). lesson = { title, course } (both optional).
  function instructions(lesson) {
    lesson = lesson || {};
    var about = lesson.title ? "the lesson \"" + lesson.title + "\"" + (lesson.course ? " (" + lesson.course + ")" : "") : "my lesson";
    return [
      "Write quiz questions for " + about + ".",
      "Reply with ONLY the questions, as plain text in the exact format below: no introduction, no numbering, no markdown, no code block.",
      "The questions may be in Arabic or English, but keep the keywords (Q:, A) to F), TF:, Correct:, MATCH:, WRITTEN:, Marks:, Model:, E:, Ch:) exactly as written here, in English.",
      "Put a blank line between questions.",
      "",
      "MULTIPLE CHOICE: 2 to 6 options A) to F). Put a * right after every correct option (more than one * = \"select all that apply\").",
      "Q: Which state of matter has a fixed shape?",
      "A) Solid *",
      "B) Liquid",
      "C) Gas",
      "E: A solid keeps its shape because its particles are held in place.",
      "",
      "TRUE / FALSE: Correct: True or Correct: False.",
      "TF: Water boils at 100 degrees Celsius at sea level.",
      "Correct: True",
      "E: At sea level the boiling point of pure water is 100 degrees Celsius.",
      "",
      "MATCHING: one line per pair, \"- term -> answer\", at least 2 pairs.",
      "MATCH: Match each state to its description",
      "- Solid -> Fixed shape and volume",
      "- Liquid -> Fixed volume, takes the shape of its container",
      "- Gas -> Fills any container",
      "",
      "WRITTEN (the student writes the answer on paper and uploads a photo; the teacher grades it): Marks = the full mark, Model = the model answer (it can continue on the next lines).",
      "WRITTEN: Explain why ice floats on water.",
      "Marks: 2",
      "Model: Ice is less dense than liquid water because its molecules form an open structure.",
      "",
      "Rules:",
      "- E: (a short explanation shown after answering) is optional on every question.",
      "- A line \"Ch: 2\" on its own puts the questions after it in chapter 2 (optional).",
      "- Math: write \\( ... \\) for inline math and \\[ ... \\] for display math, on one line. A * inside the math is not an answer marker; for a literal star at the end of an option write \\*. Inside a question write \\lt and \\gt instead of < and >.",
      "- Do not use \"$...$\" for math."
    ].join("\n");
  }

  var api = { parse: parse, splitOptionMarker: splitOptionMarker, instructions: instructions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BulkParse = api;
})(typeof window !== "undefined" ? window : this);
