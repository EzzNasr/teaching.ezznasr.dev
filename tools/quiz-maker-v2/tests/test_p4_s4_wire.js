// R-P4-S4-01: scripts/p4_wire.py on a temp copy of the real Code.gs with placeholder chunks.
// Idempotence, line endings, hooks H1-H5 text and position, a wired Code.gs that really runs, check mode,
// every broken anchor failing loudly without writing, duplicate-name and signature checks.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');
const { load } = require('./harness');
const SITE = path.resolve(__dirname, '..', '..', '..');
const WIRE = path.join(SITE, 'scripts', 'p4_wire.py');
const REAL = path.join(__dirname, '..', 'apps_script', 'Code.gs');
const py = ['python3', 'python', 'py'].find(c => { const r = cp.spawnSync(c, ['--version']); return !r.error && r.status === 0; });
let fails = 0;
const t = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + (detail === undefined ? '' : String(detail).slice(0, 400)))); if (!ok) fails++; };
if (!py) { console.log('FAIL python not found'); process.exit(1); }

const FILTERED = ['admin_list_videos', 'admin_list_lesson_tags', 'admin_list_lessons', 'admin_grant_access', 'admin_grant_quiz_access', 'admin_group_add', 'admin_list_groups', 'admin_get_all', 'admin_access_overview', 'admin_list_payments', 'admin_followup_overview', 'admin_student_summary', 'admin_monthly_review', 'admin_list_parent_notifications', 'admin_grading_queue'];
const S2F = new Set(['admin_list_videos', 'admin_list_lesson_tags', 'admin_list_lessons']);
const stub = n => `function ${n}(payload) { return { ok: true, who: "${n}" }; }\n`;
const CHUNKS = {
  'Phase4_Scope.gs': `function p4_gate(payload) { if (payload && payload.__deny) return { deny: { ok: false, error: "Not authorized." } }; return {}; }
function p4_filter(resp, payload) { resp = resp || {}; resp.__filtered = true; return resp; }
function p4_tokenAllows(payload) { return !!(payload && payload.token === "teach"); }
function p4_teacherAllows(row, c, payload) { return !!(payload && payload.__teach === true); }
function p4_pingDecorate(resp, payload) { return Object.assign({}, resp, { kind: "owner", subjects: ["*"], name: "" }); }
function p4_session_scope(payload) { return { ok: true, kind: "owner" }; }
${FILTERED.filter(a => S2F.has(a)).map(a => `function p4f_${a}(resp, ctx, payload) { return resp; }`).join('\n')}
`,
  'Phase4_People.gs': FILTERED.filter(a => !S2F.has(a)).map(a => `function p4f_${a}(resp, ctx, payload) { return resp; }`).join('\n') + '\n',
  'Phase4_Team.gs': ['p4_admin_set_teacher', 'p4_admin_list_teachers', 'p4_admin_set_group_owner', 'p4_admin_list_edit_log', 'p4_teacher_update_student', 'p4_teacher_set_assistant', 'p4_teacher_list_assistants', 'p4_teacher_revoke_assistant'].map(stub).join(''),
  'Phase4_Telegram.gs': ['p4_admin_tg_unlink', 'p4_tg_link_start', 'p4_tg_status', 'p4_tg_unlink'].map(stub).join(''),
  'Phase4_Stats.gs': stub('p4_admin_teacher_stats'),
};
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fresh(tweak) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4wire-'));
  fs.mkdirSync(path.join(dir, 'apps_script', 'chunks'), { recursive: true });
  const code = path.join(dir, 'apps_script', 'Code.gs'), chunks = path.join(dir, 'apps_script', 'chunks');
  let txt = fs.readFileSync(REAL, 'utf8');
  if (tweak) txt = tweak(txt);
  fs.writeFileSync(code, txt);
  Object.entries(CHUNKS).forEach(([n, b]) => fs.writeFileSync(path.join(chunks, n), b));
  return { dir, code, chunks, run: (...a) => cp.spawnSync(py, [WIRE, '--code', code, '--chunks', chunks, ...a], { encoding: 'utf8' }) };
}
const out = r => (r.stdout || '') + (r.stderr || '');

// --- 1. first run, second run, check -------------------------------------------------------------------------
const W = fresh();
const orig = sha(W.code);
let r = W.run('--merge', '--wire');
t('first --merge --wire exits 0', r.status === 0, out(r));
t('first run reports every chunk and hook ADDED', /Phase4_Scope\.gs\s+ADDED/.test(out(r)) && /Phase4_Stats\.gs\s+ADDED/.test(out(r)) && /H1 ADDED/.test(out(r)) && /H3 ADDED/.test(out(r)), out(r));
const after1 = sha(W.code);
t('Code.gs changed', after1 !== orig);
r = W.run('--merge', '--wire');
t('second run exits 0 and says nothing to change', r.status === 0 && /nothing to change/.test(out(r)), out(r));
t('second run leaves Code.gs byte-identical', sha(W.code) === after1);
r = W.run('--check');
t('--check passes on the assembled file', r.status === 0 && /OK/.test(out(r)), out(r));
const raw = fs.readFileSync(W.code);
const crlf = raw.toString('latin1').split('\r\n').length - 1, lf = raw.toString('latin1').split('\n').length - 1;
t('CRLF line endings preserved on every line', crlf === lf && lf > 7300, crlf + '/' + lf);
const code = raw.toString('utf8').replace(/\r\n/g, '\n');

// --- 2. hook text and position -------------------------------------------------------------------------------
const fn = n => { const a = code.indexOf('function ' + n + '('); const b = code.indexOf('\n}\n', a); return code.slice(a, b); };
const H1 = 'if (typeof p4_tokenAllows === "function" && p4_tokenAllows(payload)) return;';
const H2 = 'if (tokenOk && !isAdmin && typeof p4_teacherAllows === "function" && p4_teacherAllows(values[i], c, payload)) return true;';
const H3 = 'var __g = (typeof p4_gate === "function") ? p4_gate(payload) : null; if (__g && __g.deny) return _json(__g.deny);';
t('H1 is the first statement of _requireAdmin', fn('_requireAdmin').split('\n')[1].trim() === H1, fn('_requireAdmin').split('\n').slice(0, 3).join(' | '));
const ras = fn('_requireAdminSession');
t('H2 sits directly after the p3_assistantAllows line', ras.indexOf(H2) > ras.indexOf('p3_assistantAllows(values[i], c, payload)) return true;') && /p3_assistantAllows\(values\[i\], c, payload\)\) return true;\n\s*if \(tokenOk && !isAdmin && typeof p4_teacherAllows/.test(ras), ras);
const dp = fn('doPost');
t('H3 is the first statement of the try that holds the switch', /\n  try \{\n    var __g = [^\n]*\n    switch \(payload\.action\) \{/.test(dp));
t('H3 comes after the att_route_ and Telegram early returns', dp.indexOf(H3) > dp.indexOf('handleTelegramUpdate(e, payload)'));
t('H1, H2, H3 each appear exactly once', [H1, H2, H3].every(h => code.split(h).length === 2));
t('H4: all 15 filtered cases wrapped exactly once', FILTERED.every(a => { const m = dp.match(new RegExp('case "' + a + '":[^\\n]*\\n\\s*return _json\\(_p2Post\\("p4_filter", ')); return !!m; }) && (dp.match(/_p2Post\("p4_filter"/g) || []).length === 15);
t('H4 wraps the outermost expression (audit wrapper stays inside)', /_p2Post\("p4_filter", _p2AuditWrap\("admin_grant_access", payload, handleAdminGrantAccess\(payload\)\), payload\)/.test(dp));
t('H4 keeps the trailing comment of a wrapped line', /_p2Post\("p4_filter", _p2CallOr\("p2_admin_followup_overview"[^\n]*\), payload\)\);\s+\/\/ S2 wraps it/.test(dp));
const NEW = ['p4_session_scope', 'p4_admin_set_teacher', 'p4_admin_list_teachers', 'p4_admin_set_group_owner', 'p4_admin_tg_unlink', 'p4_admin_list_edit_log', 'p4_teacher_update_student', 'p4_teacher_set_assistant', 'p4_teacher_list_assistants', 'p4_teacher_revoke_assistant', 'p4_tg_link_start', 'p4_tg_status', 'p4_tg_unlink', 'p4_admin_teacher_stats'];
t('H5: 14 new cases, each exactly once, inside the switch', NEW.every(n => dp.split('case "' + n + '":').length === 2 && dp.includes('return _json(' + n + '(payload));')));
t('H5: ping returns the decorated object', /case "ping":\n\s+_requireAdmin\(payload\);\n\s+return _json\(_p2Post\("p4_pingDecorate", \{ ok: true, message: "pong" \}, payload\)\);/.test(dp));
t('merged sections: 5 banners and 5 END markers', (code.match(/^\/\/ ===== MERGED FROM Phase4_\w+\.gs =====$/gm) || []).length === 5 && (code.match(/^\/\/ ===== END MERGED FROM Phase4_\w+\.gs =====$/gm) || []).length === 5);
t('the earlier-phase merge markers are untouched', /MERGED FROM Phase2_Core\.gs/.test(code) && /MERGED FROM Phase2_Grading\.gs/.test(code));

// --- 3. the wired file really runs ---------------------------------------------------------------------------
try {
  const env = load(W.code);
  const { post } = env;
  const H = s => crypto.createHash('sha256').update(s).digest('hex');
  let p = post({ action: 'ping', token: 'tok' });
  t('ping with the owner token still works and is decorated', p.ok === true && p.message === 'pong' && p.kind === 'owner' && Array.isArray(p.subjects), JSON.stringify(p));
  p = post({ action: 'ping', token: 'teach' });
  t('H1: a token the placeholder accepts passes _requireAdmin (and a wrong one does not)', p.ok === true && post({ action: 'ping', token: 'nope' }).ok === false, JSON.stringify(p));
  p = post({ action: 'ping', token: 'tok', __deny: true });
  t('H3: a gate denial returns before the router and is exactly Not authorized.', p.ok === false && p.error === 'Not authorized.', JSON.stringify(p));
  p = post({ action: 'admin_list_videos', token: 'tok' });
  t('H4: a filtered action goes through p4_filter', p.ok === true && p.__filtered === true, JSON.stringify(p));
  p = post({ action: 'p4_session_scope' });
  t('H5: a new action reaches its handler', p.ok === true && p.kind === 'owner', JSON.stringify(p));
  p = post({ action: 'p4_admin_teacher_stats', token: 'tok' });
  t('H5: a handler from another chunk is reachable', p.who === 'p4_admin_teacher_stats', JSON.stringify(p));
  const reg = (ph, pw) => post({ action: 'register_student', phone: ph, password_hash: H(pw), display_name: 'S ' + ph, year: 'Senior 2', parent_phone: '01234567890' });
  const s1 = reg('01000000021', 'a');
  const creds = { student_id: s1.student_id, session_token: s1.session_token };
  p = post(Object.assign({ action: 'admin_list_videos' }, creds));
  t('H2 baseline: a plain student session is refused by _requireAdminSession', p.ok === false, JSON.stringify(p));
  p = post(Object.assign({ action: 'admin_list_videos', __teach: true }, creds));
  t('H2: the teacher hook lets that session through when the placeholder says so', p.ok === true, JSON.stringify(p));
} catch (e) { t('wired Code.gs loads and answers in the harness', false, e && e.stack); }

// --- 4. a changed chunk replaces its section, never duplicates it ---------------------------------------------
fs.writeFileSync(path.join(W.chunks, 'Phase4_Stats.gs'), stub('p4_admin_teacher_stats').replace('ok: true', 'ok: true, v: 2'));
r = W.run('--check');
t('--check notices a merged copy that differs from its chunk', r.status === 1 && /differs from chunk: Phase4_Stats\.gs/.test(out(r)), out(r));
r = W.run('--merge', '--wire');
const code2 = fs.readFileSync(W.code, 'utf8');
t('re-merge REPLACES the changed section', r.status === 0 && /Phase4_Stats\.gs\s+REPLACED/.test(out(r)) && code2.includes('v: 2') && (code2.match(/^\/\/ ===== MERGED FROM Phase4_Stats\.gs =====$/gm) || []).length === 1, out(r));
r = W.run('--list-actions');
const acts = r.stdout.trim().split('\n');
t('--list-actions prints sorted unique case labels incl. old and new', r.status === 0 && acts.includes('ping') && acts.includes('admin_get_all') && acts.includes('p4_tg_status') && acts.length > 80 && acts.join() === [...new Set(acts)].sort().join(), acts.length);

// --- 5. every broken anchor fails loudly and writes nothing ---------------------------------------------------
const broken = (name, tweak, re) => {
  const B = fresh(tweak), before = sha(B.code), res = B.run('--merge', '--wire');
  t('broken anchor: ' + name + ' -> exit 1, named, Code.gs untouched', res.status === 1 && re.test(out(res)) && sha(B.code) === before, out(res));
};
broken('_requireAdmin renamed', s => s.replace('function _requireAdmin(payload) {', 'function _requireAdminX(payload) {'), /H1: anchor missing: function _requireAdmin/);
broken('p3_assistantAllows line gone', s => s.replace(/^.*p3_assistantAllows\(values\[i\], c, payload\)\) return true;.*\r?\n/m, ''), /H2: anchor missing: the p3_assistantAllows line/);
broken('switch line changed', s => s.replace('switch (payload.action) {', 'switch (String(payload.action)) {'), /H3: anchor missing/);
broken('filtered case without _json', s => s.replace('return _json(handleAdminGetAll(payload));', 'return handleAdminGetAll(payload);'), /H4: [^]*admin_get_all/);
broken('filtered case missing', s => s.replace('case "admin_list_groups":', 'case "admin_list_groupz":'), /H4: [^]*admin_list_groups/);
broken('ping case rewritten', s => s.replace('return _json({ ok: true, message: "pong" });', 'return ContentService.createTextOutput("pong");'), /H5: [^]*ping/);
broken('mixed line endings', s => s.replace(/\r\n/, '\n'), /mixed line endings/);
{
  const B = fresh(); fs.unlinkSync(path.join(B.chunks, 'Phase4_Team.gs'));
  const before = sha(B.code), res = B.run('--merge', '--wire');
  t('missing chunk -> exit 1, nothing written', res.status === 1 && /chunk missing: Phase4_Team\.gs/.test(out(res)) && sha(B.code) === before, out(res));
  const res2 = B.run('--merge', '--wire', '--allow-missing');
  t('--allow-missing merges the rest', res2.status === 0 && /Phase4_Team\.gs\s+skipped/.test(out(res2)), out(res2));
}
{
  const B = fresh(); const res = B.run('--check');
  t('--check on an untouched Code.gs fails and lists missing hooks and chunks', res.status === 1 && /not merged: Phase4_Scope\.gs/.test(out(res)) && /hook missing: H1/.test(out(res)) && /hook H4 missing for/.test(out(res)), out(res));
}

// --- 6. post-merge sanity checks in --check -------------------------------------------------------------------
const mut = (name, file, fnEdit, re) => {
  const B = fresh(); B.run('--merge', '--wire');
  const f = path.join(B.chunks, file); fs.writeFileSync(f, fnEdit(fs.readFileSync(f, 'utf8')));
  B.run('--merge');
  const res = B.run('--check');
  t('check: ' + name, res.status === 1 && re.test(out(res)), out(res));
};
mut('a chunk redefining a Code.gs function', 'Phase4_Team.gs', s => s + 'function _json(o) { return o; }\n', /defines function _json that already exists in Code\.gs/);
mut('the same function in two chunks', 'Phase4_Stats.gs', s => s + 'function p4_tg_status(payload) { return 1; }\n', /function p4_tg_status defined in both/);
mut('a handler missing for a wired case', 'Phase4_Telegram.gs', s => s.replace(stub('p4_tg_status'), ''), /router case p4_tg_status has no handler/);
mut('p4_pingDecorate with one parameter', 'Phase4_Scope.gs', s => s.replace('function p4_pingDecorate(resp, payload)', 'function p4_pingDecorate(resp)'), /p4_pingDecorate must be \(resp, payload\)/);
mut('a p4f_ filter for an action that is not wired', 'Phase4_People.gs', s => s + 'function p4f_admin_set_video(resp, ctx, payload) { return resp; }\n', /p4f_admin_set_video .* not in the wired FILTERED list/);
{
  const B = fresh(); B.run('--merge', '--wire');
  fs.appendFileSync(path.join(B.chunks, 'Phase4_Scope.gs'), 'var P4_DUP = 1;\n'); fs.appendFileSync(path.join(B.chunks, 'Phase4_Stats.gs'), 'var P4_DUP = 2;\n');
  B.run('--merge'); const res = B.run('--check');
  t('check: a global declared in two chunks', res.status === 1 && /global P4_DUP declared in both/.test(out(res)), out(res));
}
process.exit(fails ? 1 : 0);
