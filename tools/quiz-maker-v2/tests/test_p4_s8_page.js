// P4 / S8: dashboard/teacher-stats.html (jsdom). Needs the jsdom package.
// Usage: node tests/test_p4_s8_page.js
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIP jsdom is not installed (npm i jsdom)'); process.exit(2); }
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const PAGE = path.join(__dirname, '..', '..', '..', 'dashboard', 'teacher-stats.html');
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

const blk = (o = {}) => Object.assign({ revenue: { all_time: { EGP: 100 }, this_month: { EGP: 10 }, last_month: {}, pending: {} }, payments: { approved: 1, pending: 0, rejected: 0, unpriced: 0 }, videos: 3, lessons: { total: 8, locked: 2 },
  quizzes: { locked: 1 }, students: { linked: 5, active_30d: 2 }, written: { awaiting: 1, oldest_days: 4 }, quiz_results_30d: 7, groups: 1 }, o);
const RESP = (extra = {}) => Object.assign({ ok: true, generated_at: '2026-10-31T10:00:00+02:00', cached: true, currency_note: 'Per-lesson payments are not in revenue.',
  subjects: [Object.assign({ subject: 'programming' }, blk({ groups: null })), Object.assign({ subject: 'english' }, blk({ groups: null, revenue: null })), Object.assign({ subject: 'math', shared_subject: true }, blk({ groups: null }))],
  teachers: [
    Object.assign({ phone: '01000000010', name: 'Zed', scope: ['math'], shared_subject: true, assistants: 2, telegram: true }, blk({ revenue: { all_time: { EGP: 900 }, this_month: { EGP: 90 }, last_month: {}, pending: { EGP: 5 } } })),
    Object.assign({ phone: '01000000011', name: 'Amy', scope: ['english'], assistants: 0, telegram: false }, blk({ revenue: { all_time: { EGP: 300, USD: 40 }, this_month: {}, last_month: {}, pending: {} }, students: null, written: { awaiting: 0, oldest_days: null } })),
    Object.assign({ phone: '01000000012', name: 'Mo', scope: ['math', 'english'], assistants: 1, telegram: false }, blk({ revenue: null, videos: null }))],
  owner: blk({ groups: 3 }), totals: blk() }, extra);

async function open(handler) {
  const calls = [];
  const dom = await JSDOM.fromFile(PAGE, { url: 'https://t.test/dashboard/teacher-stats.html?mock=1', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.__P4_STATS_MOCK = p => { calls.push(p); return handler(p, calls.length); }; } });
  await tick();
  dom.calls = calls;
  return dom;
}
const doc = d => d.window.document;
const rows = (d, id) => [...doc(d).querySelectorAll('#' + id + ' tbody tr')].map(tr => [...tr.children].map(td => td.textContent));
const col = (d, id, i) => rows(d, id).map(r => r[i]);

(async () => {
  {
    const d = await open(() => RESP());
    t('first load asks for stats without refresh', d.calls.length === 1 && d.calls[0].action === 'p4_admin_teacher_stats' && !('refresh' in d.calls[0]));
    t('teachers table renders one row per teacher, name first', rows(d, 's-teachers').length === 3 && rows(d, 's-teachers').map(r => r[0].replace('shared subject', '')).join() === 'Zed,Amy,Mo', JSON.stringify(col(d, 's-teachers', 0)));
    const h = [...doc(d).querySelectorAll('#s-teachers th')].map(x => x.textContent);
    t('all required teacher columns exist', ['Revenue this month', 'Revenue all time', 'Pending', 'Videos', 'Lessons locked / total', 'Quizzes locked', 'Students', 'Active 30 d', 'Grading waiting', 'Oldest (days)', 'Quiz results 30 d', 'Groups', 'Assistants', 'Telegram'].every(x => h.includes(x)), h.join());
    const z = rows(d, 's-teachers')[0];
    t('values rendered: revenue, ratio, telegram', z[2] === 'EGP 90' && z[3] === 'EGP 900' && z[4] === 'EGP 5' && z[6] === '2 / 8' && z[15] === 'Linked', JSON.stringify(z));
    const amy = rows(d, 's-teachers')[1];
    t('two currencies are shown side by side, never merged', amy[3] === 'EGP 300 · USD 40', amy[3]);
    t('null shows as n/a (students, revenue, videos)', amy[8] === 'n/a' && rows(d, 's-teachers')[2][3] === 'n/a' && rows(d, 's-teachers')[2][5] === 'n/a');
    t('a real zero is not n/a', amy[10] === '0' && amy[2] === '0', JSON.stringify(amy));
    t('shared-subject note on the teacher and the subject row', doc(d).querySelectorAll('.s-note').length === 2 && /shared subject/.test(doc(d).querySelector('#s-teachers tbody tr td').textContent));
    t('subjects table has the three subjects', col(d, 's-subjects', 0).map(x => x.replace('shared subject', '')).join() === 'programming,english,math');
    t('summary strip has 8 tiles with totals', doc(d).querySelectorAll('#s-strip .s-tile').length === 8 && /EGP 10/.test(doc(d).querySelector('#s-strip').textContent) && /EGP 100/.test(doc(d).querySelector('#s-strip').textContent));
    t('stamp says generated-at and cached', /2026-10-31T10:00:00\+02:00/.test(doc(d).querySelector('#s-stamp').textContent) && /cached/.test(doc(d).querySelector('#s-stamp').textContent));
    t('currency note shown', /not in revenue/.test(doc(d).querySelector('#s-note').textContent));

    // sorting
    const click = th => { th.dispatchEvent(new d.window.MouseEvent('click', { bubbles: true })); };
    const ths = () => [...doc(d).querySelectorAll('#s-teachers th')];
    click(ths().find(x => x.textContent.startsWith('Revenue all time')));
    t('sort ascending by revenue: Amy (340) < Zed (900), n/a last', col(d, 's-teachers', 0).map(x => x.replace('shared subject', '')).join() === 'Amy,Zed,Mo', JSON.stringify(col(d, 's-teachers', 0)));
    t('aria-sort set', ths().find(x => x.textContent.startsWith('Revenue all time')).getAttribute('aria-sort') === 'ascending');
    click(ths().find(x => x.textContent.startsWith('Revenue all time')));
    const desc = col(d, 's-teachers', 0).map(x => x.replace('shared subject', ''));
    t('click again: descending, null still last', desc[0] === 'Zed' && desc[2] === 'Mo' && ths().find(x => x.textContent.startsWith('Revenue all time')).getAttribute('aria-sort') === 'descending', desc.join());
    click(ths().find(x => x.textContent === 'Teacher'));
    t('sort by name', col(d, 's-teachers', 0).map(x => x.replace('shared subject', '')).join() === 'Amy,Mo,Zed');
    click(ths().find(x => x.textContent === 'Videos'));
    t('numeric sort puts n/a last', col(d, 's-teachers', 5).slice(-1)[0] === 'n/a');
    click(ths().find(x => x.textContent === 'Subject' || false) || doc(d).querySelector('#s-subjects th'));
    t('subjects table sorts independently', col(d, 's-subjects', 0).map(x => x.replace('shared subject', '')).join() === 'english,math,programming');
    const keyEv = new d.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    ths()[0].dispatchEvent(keyEv);
    t('headers are keyboard-operable (Enter)', ths()[0].getAttribute('aria-sort') !== null);

    // refresh
    d.window.__P4_STATS_MOCK = p => { d.calls.push(p); return RESP({ cached: false, generated_at: '2026-10-31T10:05:00+02:00' }); };
    doc(d).querySelector('#s-refresh').click(); await tick();
    t('Refresh sends refresh:true', d.calls.length === 2 && d.calls[1].refresh === true);
    t('stamp now says fresh and the new time', /10:05:00/.test(doc(d).querySelector('#s-stamp').textContent) && /fresh/.test(doc(d).querySelector('#s-stamp').textContent));
    t('sort order survives a refresh', doc(d).querySelector('#s-teachers th[aria-sort]') !== null);
  }
  {
    const d = await open(() => ({ ok: false, error: 'Not authorized.' }));
    t('an error response shows its message and no tables', doc(d).querySelector('#s-error').textContent === 'Not authorized.' && !doc(d).querySelector('table'));
  }
  {
    const d = await open(() => { throw new Error('Network down'); });
    t('a thrown error shows its message', doc(d).querySelector('#s-error') && /Network down/.test(doc(d).querySelector('#s-error').textContent));
  }
  {
    const evil = '<img src=x onerror="window.PWNED=1"><script>window.PWNED=1</script>';
    const r = RESP(); r.teachers[0].name = evil; r.teachers[1].name = '"><svg onload=window.PWNED=1>'; r.currency_note = evil; r.generated_at = evil;
    const before = (await open(() => RESP())).window.document.querySelectorAll('script').length;
    const d = await open(() => r);
    await tick(60);
    t('hostile text is shown literally', rows(d, 's-teachers')[0][0].startsWith(evil) && doc(d).querySelector('#s-note').textContent === evil && doc(d).querySelector('#s-stamp').textContent.includes(evil));
    t('...and never executed or turned into elements', d.window.PWNED === undefined && doc(d).querySelectorAll('img,svg').length === 0 && doc(d).querySelectorAll('script').length === before);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
