#!/usr/bin/env node
// Read-only smoke test of the DEPLOYED Apps Script web app. Run it right after "Deploy > New version".
//   node scripts/smoke_live.js                       uses the DRIVE_ENDPOINT baked into assets/assign.js
//   node scripts/smoke_live.js https://.../exec      any endpoint (also used by the self-test against a local backend)
// It only sends requests that must be REJECTED or that read public data. It never logs in, grades or writes.
// Catches: wrong/old version pasted, deploy not updated, router broken, a feature flag left in the wrong state.
const fs = require('fs'), path = require('path');
const site = path.resolve(__dirname, '..');
let url = process.argv[2];
if (!url) {
  const m = /DRIVE_ENDPOINT\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(site, 'assets/assign.js'), 'utf8'));
  if (!m) { console.log('FAIL no DRIVE_ENDPOINT in assets/assign.js (run "Sync site assets")'); process.exit(1); }
  url = m[1];
}
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const post = async body => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), redirect: 'follow' });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { return { _raw: txt.slice(0, 120), _status: r.status }; }
};
(async () => {
  console.log('endpoint: ' + url.replace(/(\/s\/.{6}).*(\/exec)/, '$1...$2'));
  let r;
  try { r = await post({ action: 'ping' }); } catch (e) { t('endpoint reachable', false, e.message); return done(); }
  t('endpoint reachable and answers JSON', r && !r._raw, JSON.stringify(r));
  t('ping is routed (ok, or "Not authorized" because it needs the admin token)', r && (r.ok === true || /Not authorized/i.test(r.error || '')), JSON.stringify(r));
  r = await post({ action: '__smoke_unknown__' });
  t('router rejects an unknown action', r.ok === false && /Unknown action/i.test(r.error || ''), JSON.stringify(r));
  for (const a of ['admin_student_summary', 'admin_grading_queue', 'admin_access_overview', 'admin_followup_overview']) {
    r = await post({ action: a });                                   // no token: must be refused, and must NOT be "not implemented"
    t(a + ': refused without admin token, and the handler is deployed', r.ok === false && !r.not_implemented && !/Unknown action|Not implemented/i.test(r.error || ''), JSON.stringify(r));
  }
  // Attendance (Attendance.gs): proves the 4 att*.gs files are pasted AND the router hook is deployed. Writes nothing.
  r = await post({ action: 'att_status', session_id: 'S-SMOKE-NONE' });
  t('att_status answers NO_SESSION (Attendance.gs deployed + routed)', r.ok === false && r.code === 'NO_SESSION', JSON.stringify(r));
  r = await post({ action: 'att_rooms' });
  t('att_rooms refused without admin token (UNAUTHORIZED, not "Unknown action")', r.ok === false && r.code === 'UNAUTHORIZED', JSON.stringify(r));
  r = await post({ action: 'att_roster' });
  t('att_roster refused without admin token', r.ok === false && r.code === 'UNAUTHORIZED', JSON.stringify(r));
  r = await post({ action: 'login_student', phone: '01000000000', password_hash: '0'.repeat(64) });
  t('login with a bogus account is rejected and returns no session', r.ok === false && !r.session_token, JSON.stringify(r));
  r = await post({ action: 'get_quiz', lesson: '__smoke_no_such_lesson__' });
  t('get_quiz for a missing lesson fails cleanly (no answers leaked)', r.ok === false || !JSON.stringify(r).match(/"correct(_answer)?"/), JSON.stringify(r));
  done();
})().catch(e => { console.log('FAIL ' + e.message); process.exit(1); });
function done() { console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0); }
