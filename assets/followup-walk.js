/* followup-walk.js — the "parent messages, one student at a time" walk-through (Follow-up v2, session S3).
 *
 *   FollowupWalk.open({
 *     group,                      // the group object from the overview
 *     rows,                       // [{key, name, parent_phone, issues:[{kind, lesson, label}], message?}]  already filtered to the due students
 *     templates,                  // overview.templates (saved overrides of the message templates)
 *     kind,                       // "parents_watch" | "parents_hw" | "attendance_none"
 *     onDone({sent, skipped}),    // phoneKey lists; called once, when the person finishes or presses "كفاية دلوقتي"
 *     onClose(),                  // called once when the sheet goes away (after onDone, or on its own when closed without it)
 *     // optional additions (never needed by the contract):
 *     compose(row) -> string,     // your own message for a row (wins over row.message and the built-in composer)
 *     context: {lessons, facts(key), deadlines, now, settings}   // extra input for the built-in composer
 *   }) -> { close() }
 *
 * What it does: a full-screen sheet, one student per step: the name, why (chips), the parent's number with the
 * same warnings the page shows, the message in a WhatsApp-style bubble (editable for this message only), a big
 * "فتح واتساب" link (https://wa.me/<digits>?text=... built by FollowupTemplates.waLink), then "التالي".
 * Buttons: السابق · تخطّي · التالي · كفاية دلوقتي. Progress "3 من 8".
 *
 * It NEVER sends anything: the person taps the WhatsApp link and presses send in WhatsApp. "Next" is only enabled
 * after the link was opened (or the text copied), so a student ends up in exactly one list:
 *   sent    = WhatsApp opened (or copied) and "التالي" pressed   -> the page logs these with admin_log_parent_notification
 *   skipped = "تخطّي"
 * Students not reached before "كفاية دلوقتي" are in neither list.
 *
 * Dependency-free. It uses window.FollowupTemplates (message composer, WhatsApp link, bubble formatting) and
 * window.FollowupLogic (parent phone check) when they are on the page, and has plain fallbacks when not.
 * Needs assets/followup-walk.css. UMD: window.FollowupWalk in browsers, module.exports in Node (the pure flow
 * core, FollowupWalk.createFlow, is what the Node test exercises; open() needs a DOM).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FollowupWalk = factory(root);
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var KIND_TITLE = {
    parents_watch: 'رسائل أولياء الأمور — المشاهدة',
    parents_hw: 'رسائل أولياء الأمور — الواجب والكويز',
    attendance_none: 'رسائل أولياء الأمور — الحضور غير محدد'
  };

  /* ================================================================ pure flow core (no DOM) */
  function pkOf(v) {
    var L = root && root.FollowupLogic;
    if (L && L.phoneKey) return L.phoneKey(v);
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    return d.length > 10 ? d.slice(-10) : d;
  }

  /** The state machine behind the sheet. rows: [{key,...}] (rows without a key and repeated keys are dropped). */
  function createFlow(rows) {
    var list = [], seen = {};
    (rows || []).forEach(function (r) {
      var k = r && r.key != null ? String(r.key) : '';
      if (!k || seen[k]) return;
      seen[k] = 1; list.push(r);
    });
    var n = list.length, idx = 0, status = {}, acted = {};
    function cur() { return idx < n ? list[idx] : null; }
    function advance() { idx = Math.min(idx + 1, n); }
    var f = {
      total: function () { return n; },
      index: function () { return idx; },
      position: function () { return Math.min(idx + 1, n); },     // 1-based for "3 من 8"
      current: cur,
      finished: function () { return idx >= n; },
      status: function (k) { return status[k] || null; },
      acted: function (k) { return !!acted[k]; },
      act: function (k) { if (seen[k]) acted[k] = true; },        // WhatsApp opened / text copied
      canNext: function () { var c = cur(); return !!(c && acted[c.key]); },
      next: function () { var c = cur(); if (!c || !acted[c.key]) return false; status[c.key] = 'sent'; advance(); return true; },
      skip: function () { var c = cur(); if (!c) return false; status[c.key] = 'skipped'; advance(); return true; },
      back: function () { if (idx <= 0) return false; idx--; return true; },
      result: function () {
        var sent = [], skipped = [];
        list.forEach(function (r) { if (acted[r.key] || status[r.key] === 'sent') sent.push(r.key); else if (status[r.key] === 'skipped') skipped.push(r.key); });   // opened WhatsApp / copied = sent, even before "Next"
        return { sent: sent, skipped: skipped };
      },
      rows: function () { return list.slice(); }
    };
    return f;
  }

  /* ================================================================ helpers */
  var FT = function () { return root && root.FollowupTemplates; };
  var FL = function () { return root && root.FollowupLogic; };

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  function phoneCheck(row) {
    var L = FL();
    try { if (L && L.checkParentPhone) return L.checkParentPhone(row.parent_phone, row.key); } catch (e) { /* fall through */ }
    var d = String(row.parent_phone == null ? '' : row.parent_phone).replace(/\D/g, '');
    if (!d) return { level: 'missing', reason: '', wa: '', canSend: false };
    return { level: d.length < 10 ? 'warn' : 'ok', reason: d.length < 10 ? 'رقم ولي الأمر أقصر من ١٠ أرقام' : '', wa: d.length < 10 ? '' : (d.length === 11 && d.charAt(0) === '0' ? '2' + d : d), canSend: d.length >= 10 };
  }

  function lessonLabel(path) {
    var T = FT();
    try { if (T && T.prettyLesson) return T.prettyLesson(path); } catch (e) { /* ignore */ }
    return String(path || '').split('/').pop();
  }

  /** The message for one row: opts.compose(row) > row.message > the built-in composer (FollowupTemplates). */
  function messageFor(opts, row) {
    var out = { text: '', error: '', missing: [] };
    try {
      if (typeof opts.compose === 'function') { var c = opts.compose(row); if (c != null && c !== '') { out.text = typeof c === 'string' ? c : String(c.text || ''); return out; } }
      if (typeof row.message === 'string' && row.message !== '') { out.text = row.message; return out; }
      var T = FT(), issues = row.issues || [];
      if (!T || !T.composeFull || !issues.length) { out.error = 'مفيش رسالة جاهزة للطالب ده.'; return out; }
      var ctxIn = opts.context || {};
      var list = issues.map(function (i) { return { template: i.kind, lesson: i.lesson }; });
      var single = list.length === 1;
      var ctx = {
        templates: opts.templates || {}, student: { name: row.name, phone: row.key, parent_phone: row.parent_phone }, group: opts.group || {},
        lesson: single ? list[0].lesson : undefined, issues: single ? undefined : list, now: ctxIn.now || new Date(),
        lessons: ctxIn.lessons, deadlines: ctxIn.deadlines, settings: ctxIn.settings,
        facts: typeof ctxIn.facts === 'function' ? ctxIn.facts(row.key, single ? list[0].lesson : null) : ctxIn.facts
      };
      var r = T.composeFull({ student: ctx.student, group: ctx.group, verdicts: null }, single ? list[0].template : 'combined', ctx);
      out.text = (r && r.text) || ''; out.missing = (r && r.missing) || [];
      if (!out.text) out.error = 'تعذّر تجهيز الرسالة.';
    } catch (e) { out.error = 'تعذّر تجهيز الرسالة: ' + (e && e.message ? e.message : e); }
    return out;
  }

  function waHref(digits, text) {
    var T = FT();
    if (T && T.waLink) return T.waLink(digits, text);
    return 'https://wa.me/' + String(digits).replace(/\D/g, '') + (text ? '?text=' + encodeURIComponent(text) : '');
  }

  function copyText(text) {
    var T = FT(), p = null;
    try { if (T && T.copyText) p = T.copyText(text); } catch (e) { p = null; }
    if (p && typeof p.then === 'function') return p;
    return new Promise(function (resolve) {
      try {
        var ta = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' }); ta.value = text;
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
        var ok = document.execCommand('copy'); document.body.removeChild(ta); resolve(!!ok);
      } catch (e) { resolve(false); }
    });
  }

  /* ================================================================ the sheet */
  function open(opts) {
    opts = opts || {};
    if (typeof document === 'undefined') throw new Error('FollowupWalk.open needs a browser');
    var flow = createFlow(opts.rows), edits = {}, closed = false, doneCalled = false, confirming = false;
    var opener = document.activeElement, prevOverflow = document.body.style.overflow;
    var groupName = (opts.group && (opts.group.group || opts.group.name)) || '';
    var title = KIND_TITLE[opts.kind] || 'رسائل أولياء الأمور';
    var msgCache = {};

    var overlay = h('div', { class: 'fw-overlay', dir: 'rtl', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'data-fw': 'root' });
    var panel = h('div', { class: 'fw-panel' });
    overlay.appendChild(panel);

    function result() { return flow.result(); }
    function finish(callDone) {
      if (closed) return;
      if (callDone && !doneCalled) { doneCalled = true; try { if (opts.onDone) opts.onDone(result()); } catch (e) { if (root.console) root.console.error(e); } }
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      try { if (opener && opener.focus) opener.focus(); } catch (e) { /* ignore */ }
      try { if (opts.onClose) opts.onClose(); } catch (e2) { if (root.console) root.console.error(e2); }
    }
    function requestClose() {
      if (closed) return;
      if (result().sent.length && !doneCalled) { confirming = true; paint(); return; }   // do not lose the WhatsApp messages already opened
      finish(false);
    }

    function focusables() {
      return Array.prototype.slice.call(panel.querySelectorAll('button:not([disabled]), a[href], textarea, [tabindex="0"]')).filter(function (e) { return e.offsetParent !== null || e === document.activeElement; });
    }
    function onKey(ev) {
      if (closed) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (confirming) { confirming = false; paint(); } else requestClose(); return; }
      if (ev.key === 'Tab') {
        var f = focusables(); if (!f.length) return;
        var first = f[0], last = f[f.length - 1], a = document.activeElement;
        if (!overlay.contains(a)) { ev.preventDefault(); first.focus(); }
        else if (ev.shiftKey && a === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && a === last) { ev.preventDefault(); first.focus(); }
      }
    }

    function header() {
      var total = flow.total(), pos = flow.finished() ? total : flow.position();
      var pct = total ? Math.round((flow.index() / total) * 100) : 100;
      var bar = h('div', { class: 'fw-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(Math.min(flow.index(), total)), 'aria-label': 'التقدّم' }, [h('i', { style: 'width:' + pct + '%' })]);
      return [h('header', { class: 'fw-top' }, [
        h('button', { class: 'fw-x', type: 'button', 'aria-label': 'إغلاق', 'data-fw': 'close', onclick: requestClose }, ['✕']),
        h('div', { class: 'fw-head' }, [h('div', { class: 'fw-title' }, [title]), groupName ? h('div', { class: 'fw-sub', dir: 'auto' }, [groupName]) : null]),
        h('div', { class: 'fw-count', 'data-fw': 'count', 'aria-live': 'polite' }, [total ? (pos + ' من ' + total) : '0'])
      ]), bar];
    }

    function emptyView() {
      return [h('main', { class: 'fw-body' }, [h('div', { class: 'fw-empty', 'data-fw': 'empty' }, ['مفيش طلاب في القايمة دي.'])]),
        h('footer', { class: 'fw-actions' }, [h('button', { class: 'fw-btn primary', type: 'button', 'data-fw': 'finish', onclick: function () { finish(true); } }, ['إغلاق'])])];
    }

    function summaryView() {
      var r = result(), sent = r.sent.length, skipped = r.skipped.length;
      return [h('main', { class: 'fw-body' }, [h('div', { class: 'fw-summary', 'data-fw': 'summary' }, [
        h('div', { class: 'fw-big' }, ['🎉 خلّصنا القايمة']),
        h('p', {}, ['فتحت واتساب لـ ', h('b', {}, [String(sent)]), ' طالب', skipped ? (' · وتخطّيت ' + skipped) : '', '.']),
        sent ? h('p', { class: 'fw-dim' }, ['اضغط «إنهاء وتسجيل» عشان يتسجّل إنك بلّغت أولياء الأمور دول.']) : null
      ])]), h('footer', { class: 'fw-actions' }, [
        h('button', { class: 'fw-btn primary', type: 'button', 'data-fw': 'finish', onclick: function () { finish(true); } }, [sent ? '✓ إنهاء وتسجيل' : 'إنهاء']),
        h('button', { class: 'fw-btn', type: 'button', 'data-fw': 'back', onclick: function () { flow.back(); paint(); } }, ['السابق'])
      ])];
    }

    function confirmView() {
      var n = result().sent.length;
      return [h('main', { class: 'fw-body' }, [h('div', { class: 'fw-summary', 'data-fw': 'confirm', role: 'alertdialog', 'aria-label': 'تأكيد الإغلاق' }, [
        h('div', { class: 'fw-big' }, ['لسه في رسايل اتفتحت']),
        h('p', {}, ['فتحت واتساب لـ ', h('b', {}, [String(n)]), ' طالب. تسجّلهم قبل ما تقفل؟'])
      ])]), h('footer', { class: 'fw-actions' }, [
        h('button', { class: 'fw-btn primary', type: 'button', 'data-fw': 'confirm-save', onclick: function () { finish(true); } }, ['✓ سجّل وأنهِ']),
        h('button', { class: 'fw-btn', type: 'button', 'data-fw': 'confirm-keep', onclick: function () { confirming = false; paint(); } }, ['كمّل']),
        h('button', { class: 'fw-btn quiet', type: 'button', 'data-fw': 'confirm-discard', onclick: function () { finish(false); } }, ['اقفل من غير تسجيل'])
      ])];
    }

    function studentView() {
      var row = flow.current(), key = row.key, ck = phoneCheck(row);
      var m = msgCache[key] || (msgCache[key] = messageFor(opts, row));
      var text = edits[key] !== undefined ? edits[key] : m.text;
      var digits = ck.wa || '';
      var body = h('main', { class: 'fw-body' });
      body.appendChild(h('h2', { class: 'fw-name', dir: 'auto', 'data-fw': 'name' }, [row.name || row.key]));
      var chips = h('div', { class: 'fw-chips', 'data-fw': 'chips' });
      (row.issues || []).forEach(function (i) {
        var label = i.label || i.kind;
        chips.appendChild(h('span', { class: 'fw-chip', dir: 'auto' }, [label, i.lesson ? h('small', { dir: 'auto' }, [lessonLabel(i.lesson)]) : null]));
      });
      if (!(row.issues || []).length) chips.appendChild(h('span', { class: 'fw-chip' }, ['—']));
      body.appendChild(chips);
      body.appendChild(h('div', { class: 'fw-phone' }, [h('span', { class: 'fw-dim' }, ['ولي الأمر: ']), row.parent_phone ? h('bdi', { class: 'fw-num', dir: 'ltr' }, [String(row.parent_phone)]) : h('span', { class: 'fw-dim' }, ['—'])]));
      if (ck.level === 'missing') body.appendChild(h('div', { class: 'fw-warn', id: 'fw-phonewarn', role: 'alert', 'data-fw': 'phonewarn' }, ['⚠️ لا يوجد رقم ولي أمر — زر واتساب متوقف، تقدر تنسخ الرسالة.']));
      else if (ck.level === 'warn') body.appendChild(h('div', { class: 'fw-warn', role: 'alert', 'data-fw': 'phonewarn' }, ['⚠️ راجع رقم ولي الأمر قبل الإرسال. ' + (ck.reason || '')]));
      if (m.error) body.appendChild(h('div', { class: 'fw-warn', role: 'alert', 'data-fw': 'msgerror' }, ['⚠️ ' + m.error]));
      if (m.missing && m.missing.length) body.appendChild(h('div', { class: 'fw-warn', 'data-fw': 'missingvars' }, ['متغيرات غير معروفة في القالب: ' + m.missing.join(' ')]));

      var bubble = h('div', { class: 'fw-bubble', dir: 'auto', 'data-fw': 'bubble' });
      var ta = h('textarea', { class: 'fw-edit', dir: 'auto', rows: '6', 'aria-label': 'نص الرسالة', 'data-fw': 'edit', hidden: true });
      ta.value = text;
      var link = h('a', { class: 'fw-btn wa', target: '_blank', rel: 'noopener', 'data-fw': 'wa' }, ['فتح واتساب ↗']);
      var nextBtn;
      function setNext() {
        if (!nextBtn) return;
        var ok = flow.canNext();
        nextBtn.disabled = !ok; nextBtn.setAttribute('aria-disabled', ok ? 'false' : 'true');
        nextBtn.title = ok ? '' : 'افتح واتساب (أو انسخ الرسالة) الأول';
      }
      function sync() {
        var t = ta.value;
        edits[key] = t;
        var T = FT();
        try { if (T && T.formatPreview) bubble.innerHTML = T.formatPreview(t); else bubble.textContent = t; } catch (e) { bubble.textContent = t; }
        if (digits && t) { link.setAttribute('href', waHref(digits, t)); link.removeAttribute('aria-disabled'); }
        else { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); }
      }
      link.addEventListener('click', function (ev) {
        if (link.getAttribute('aria-disabled') === 'true' || !link.getAttribute('href')) { ev.preventDefault(); return; }
        flow.act(key); setNext(); link.setAttribute('data-opened', 'true'); statusLine.textContent = '✓ اتفتح واتساب — ابعت الرسالة هناك وارجع اضغط «التالي».';
      });
      ta.addEventListener('input', sync);
      var statusLine = h('div', { class: 'fw-status', 'data-fw': 'status', 'aria-live': 'polite' }, [flow.acted(key) ? '✓ اتفتح واتساب قبل كده — تقدر تكمّل.' : '']);
      var editBtn = h('button', { class: 'fw-btn small', type: 'button', 'data-fw': 'edit-toggle', 'aria-expanded': 'false', onclick: function () {
        var show = ta.hasAttribute('hidden'); if (show) ta.removeAttribute('hidden'); else ta.setAttribute('hidden', '');
        editBtn.setAttribute('aria-expanded', String(show)); if (show) ta.focus();
      } }, ['✏️ تعديل النص']);
      var copyBtn = h('button', { class: 'fw-btn small', type: 'button', 'data-fw': 'copy', onclick: function () {
        copyText(ta.value).then(function (ok) { if (ok) { flow.act(key); setNext(); statusLine.textContent = '📋 اتنسخت — الصقها في واتساب وارجع اضغط «التالي».'; } else statusLine.textContent = 'تعذّر النسخ — حدّد النص وانسخه يدويًا.'; });
      } }, ['📋 نسخ']);
      body.appendChild(bubble);
      body.appendChild(h('div', { class: 'fw-tools' }, [editBtn, copyBtn]));
      body.appendChild(ta);
      sync();
      nextBtn = h('button', { class: 'fw-btn primary', type: 'button', 'data-fw': 'next', onclick: function () { if (flow.next()) paint(); } }, ['التالي ←']);
      var foot = h('footer', { class: 'fw-actions' }, [
        link, statusLine,
        h('div', { class: 'fw-row3' }, [
          h('button', { class: 'fw-btn', type: 'button', 'data-fw': 'back', onclick: function () { if (flow.back()) paint(); }, disabled: flow.index() === 0 }, ['→ السابق']),
          h('button', { class: 'fw-btn', type: 'button', 'data-fw': 'skip', onclick: function () { flow.skip(); paint(); } }, ['تخطّي']),
          nextBtn
        ]),
        h('button', { class: 'fw-btn quiet', type: 'button', 'data-fw': 'done-now', onclick: function () { finish(true); } }, ['✔ كفاية دلوقتي'])
      ]);
      setNext();
      return { nodes: [body, foot], focus: link.getAttribute('href') ? link : nextBtn };
    }

    function paint() {
      if (closed) return;
      while (panel.firstChild) panel.removeChild(panel.firstChild);
      header().forEach(function (n) { panel.appendChild(n); });
      var focus = null, parts;
      if (confirming) parts = confirmView();
      else if (!flow.total()) parts = emptyView();
      else if (flow.finished()) parts = summaryView();
      else { var v = studentView(); parts = v.nodes; focus = v.focus; }
      parts.forEach(function (n) { panel.appendChild(n); });
      var body = panel.querySelector('.fw-body'); if (body) body.scrollTop = 0;
      var f = focus || panel.querySelector('.fw-actions .fw-btn.primary') || panel.querySelector('.fw-x');
      if (f && f.focus) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
    }

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey, true);
    paint();
    return { close: function () { finish(false); } };
  }

  return { VERSION: VERSION, open: open, createFlow: createFlow, KIND_TITLE: KIND_TITLE };
}));
