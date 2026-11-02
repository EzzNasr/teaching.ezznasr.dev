// R-P4-S4-03: tests/fixtures/p4_matrix.json (S4's transcription of contract section 5) against the REAL router in
// Code.gs. Needs no Phase 4 code, so it is active from day one and catches drift whenever Code.gs changes.
const fs = require('fs'), path = require('path');
const SITE = path.resolve(__dirname, '..', '..', '..');
const code = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'p4_matrix.json'), 'utf8'));
const wire = fs.readFileSync(path.join(SITE, 'scripts', 'p4_wire.py'), 'utf8');
let fails = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 500))); if (!ok) fails++; };

const funcBody = name => { const m = new RegExp('^function ' + name + '\\(', 'm').exec(code); if (!m) return null; const e = /^}[ \t]*$/m.exec(code.slice(m.index)); const line = code.slice(m.index).split('\n')[0]; return e ? code.slice(m.index, m.index + e.index + 1) : line; };
const dpA = code.indexOf('function doPost('), dpB = code.indexOf('\n}\n', dpA), dp = code.slice(dpA, dpB);
const routerCases = [...new Set([...dp.matchAll(/^[ \t]*case "([^"]+)":/gm)].map(m => m[1]))];
const wired = new Set(((wire.match(/NEW_CASES = \[([^\]]*)\]/s) || [, ''])[1].match(/"p4_[a-z_]+"/g) || []).map(x => x.replace(/"/g, '')));   // NEW_CASES in p4_wire.py
const byAction = Object.fromEntries(fx.actions.map(a => [a.action, a]));

t('fixture has one row per action, no duplicates', Object.keys(byAction).length === fx.actions.length, fx.actions.length);
t('fixture keys are well formed', fx.actions.every(a => ['PUB', 'O', 'T', 'TEAM'].includes(a.rule) && a.needs.every(n => fx.needs[n]) && a.via.every(v => v === 'tok' || v === 'ses')), '');
t('callers and contexts are the 7 x 3 grid of the brief', fx.callers.length === 7 && fx.contexts.join() === 'math,programming,none');

// every existing router action in the table exists; every p4_ action is one p4_wire.py wires
// integration (follow-up v2): admin_fu2_* / admin_req_* are routed by doPost's default branch to fu2_dispatch_
// (FollowupRouter.gs), which merges the route maps of FollowupNotify.gs / Requirements.gs. Such a row counts as a router
// case when its name is a key of one of those route maps.
const FU2_SRC = ['FollowupNotify.gs', 'Requirements.gs', 'FollowupRouter.gs'].map(n => { try { return fs.readFileSync(path.join(__dirname, '..', 'apps_script', n), 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return ''; } }).join('\n');
const fu2Routed = a => /^admin_(fu2|req)_/.test(a) && /\^admin_\(fu2\|req\)_/.test(dp) && new RegExp('["\']?' + a + '["\']?\\s*:').test(FU2_SRC);
const missing = fx.actions.filter(a => !a.action.startsWith('p4_') && !routerCases.includes(a.action) && !fu2Routed(a.action)).map(a => a.action);
t('every non-p4 action in the table is a real router case', missing.length === 0, missing.join(', '));
const p4rows = fx.actions.filter(a => a.action.startsWith('p4_')).map(a => a.action);
t('the p4_ rows are exactly the cases p4_wire.py adds (plus none missing)', p4rows.every(a => wired.has(a)) && [...wired].filter(a => !p4rows.includes(a)).length === 0, p4rows.filter(a => !wired.has(a)).concat([...wired].filter(a => !p4rows.includes(a))).join(', '));

// deny-by-default coverage: any admin-ish router action must be in the table, or a teacher would reach it unchecked
const adminish = routerCases.filter(c => /^(admin_|p3_admin_|p4_admin_)/.test(c) || c === 'upload_attachment' || c === 'delete_attachment');
const unclassified = adminish.filter(c => !byAction[c]);
t('every admin_/p3_admin_ router action has a row (new ones must be classified)', unclassified.length === 0, unclassified.join(', '));
const sensitive = routerCases.filter(c => !byAction[c] && /^(get_written_image)$/.test(c));
t('get_written_image has a row', sensitive.length === 0);

// filters: the wired list in p4_wire.py equals the filter column
const FIL = (wire.match(/FILTERED = \[([^\]]*)\]/s) || [, ''])[1].match(/"([a-z_0-9]+)"/g).map(s => s.replace(/"/g, ''));
const fixFil = fx.actions.filter(a => a.filter).map(a => a.action);
t('filter column == FILTERED in p4_wire.py', JSON.stringify([...FIL].sort()) === JSON.stringify([...fixFil].sort()), FIL.filter(a => !fixFil.includes(a)).concat(fixFil.filter(a => !FIL.includes(a))).join(', '));
t('every filter name is p4f_<action>', fx.actions.filter(a => a.filter).every(a => a.filter === 'p4f_' + a.action));

// payload field names exist in the handlers (the only deviation the contract allows is a field name)
const handlerBody = action => {
  const m = new RegExp('case "' + action + '":[^\\n]*\\n(?:[ \\t]*(?://[^\\n]*)?\\n)*[ \\t]*(?:[A-Za-z_]\\w*\\([^\\n]*\\);[ \\t]*\\n[ \\t]*)?(?:return _json\\()?([^\\n]*)').exec(dp);
  if (!m) return null;
  const names = [...m[1].matchAll(/\b(handle[A-Za-z0-9_]+|p2_[a-z_0-9]+|p3_[a-z_0-9]+)\b/g)].map(x => x[1]);
  let body = '';
  names.forEach(n => { const b = funcBody(n); if (b) { body += b; [...b.matchAll(/\b(handle[A-Za-z0-9_]+)\(payload/g)].forEach(x => { body += funcBody(x[1]) || ''; }); } });
  return body;
};
const has = (body, f) => new RegExp('\\b(?:payload|p)\\.' + f + '\\b|\\["' + f + '"\\]').test(body);
fx.actions.filter(a => !a.action.startsWith('p4_') && Object.keys(a.fields).length).forEach(a => {
  let body = handlerBody(a.action);
  if (!body && fu2Routed(a.action)) {   // integration: the handler named in the route map (e.g. admin_fu2_mark_done: fu2_notify_markDone_)
    const m = new RegExp('["\']?' + a.action + '["\']?\\s*:\\s*(?:[A-Za-z_0-9]+\\()?([A-Za-z_0-9]+)').exec(FU2_SRC);
    const fm = m && new RegExp('^function ' + m[1] + '\\(', 'm').exec(FU2_SRC);
    body = fm ? FU2_SRC.slice(fm.index, fm.index + (/^}[ \t]*$/m.exec(FU2_SRC.slice(fm.index)) || { index: 2000 }).index + 1) : null;
  }
  if (!body) return t('handler found for ' + a.action, false, 'no handler body');
  const bad = [];
  Object.entries(a.fields).forEach(([k, v]) => {
    if (k === 'group' && a.group_optional) return;   // the contract says "if a group field is present"; today's handler ignores it
    const names = v.includes('[]') ? ['items'] : [v];
    names.forEach(f => { if (!has(body, f)) bad.push(k + '=' + v); });
  });
  t('fields of ' + a.action + ' exist in its handler', bad.length === 0, bad.join(', '));
});
fx.actions.filter(a => a.resolve).forEach(a => { const b = handlerBody(a.action); t(a.action + ' resolves its lesson from ' + a.resolve, !!b && has(b, a.resolve), a.resolve); });
t('assistant_deny matches contract A16', JSON.stringify(fx.assistant_deny) === JSON.stringify(['admin_decide_payment', 'admin_list_payments', 'admin_followup_save_templates', 'p4_*']));
process.exit(fails ? 1 : 0);
