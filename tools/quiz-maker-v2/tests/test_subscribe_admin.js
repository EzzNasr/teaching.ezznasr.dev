// R-SUB-ADMIN  A signed-in admin saw «سجّل الدخول برقم هاتفك…» on a grade page's Subscriptions card.
// Cause: get_subscription_options answered signed_in:false for any session that is not a student
// row (signed_in was !!phone), and assets/subscribe.js shows the sign-in prompt on signed_in:false.
// This runs the real subscribe.js in a small fake page, wired to the real Code.gs through the
// harness, for: guest, stale session, student, admin, and an admin against an OLD backend reply
// (no `viewer` field, signed_in:false — what Version 74 still answers until the next deploy).
// Usage: node tests/test_subscribe_admin.js apps_script/Code.gs [site root]
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { load } = require('./harness');
const codeGs = process.argv[2];
const root = path.resolve(process.argv[3] || path.join(__dirname, '..', '..', '..'));
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');

// ---- backend: a teacher (admin), a student, one tagged chapter -----------------------------
const env = load(codeGs, { props: { YEAR_END_G1: '2027-08-01', YEAR_END_G2: '2027-08-01' } });
const { post, getSS } = env;
const reg = (phone, pw, name) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 1', parent_phone: '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher');
const stu = reg('01000000002', 'b', 'Sara');
const sh = getSS('STU').getSheetByName('Students');
let adminCol = 0; for (let c = 1; c <= 20; c++) if (sh.get(1, c) === 'is_admin') adminCol = c;
sh.set(2, adminCol, true);
const G1 = 'programming/baccalaureate/grade-1-secondary';
const L = G1 + '/chapter-1-lesson-1-intro';
post({ action: 'admin_set_video', lesson: L, slot: 'lesson', video_url: 'https://www.youtube.com/embed/AAAAAAAAAAA', token: 'tok' });
const ADMIN = { student_id: adm.student_id, session_token: adm.session_token };
const STU = { student_id: stu.student_id, session_token: stu.session_token };
post(Object.assign({ action: 'admin_set_lesson_tags', lesson: L, chapter: 1, term: 1 }, ADMIN));

const opts = creds => post(Object.assign({ action: 'get_subscription_options', grade: 'grade-1-secondary' }, creds || {}));
{
  const a = opts(ADMIN), s = opts(STU), g = opts(null), st = opts({ student_id: STU.student_id, session_token: 'stale' });
  t('backend: an admin session is signed in (viewer admin), options listed as available', a.ok && a.signed_in === true && a.viewer === 'admin' && a.chapters.length === 1 && a.chapters[0].state === 'available', JSON.stringify(a));
  t('backend: a student session is signed in (viewer student)', s.ok && s.signed_in === true && s.viewer === 'student', JSON.stringify(s));
  t('backend: no session is a guest, not signed in, and gets no cards or prices', g.ok && g.signed_in === false && g.viewer === 'guest' && !g.chapters && !g.term && !g.prices, JSON.stringify(g));
  t('backend: a stale session is a guest too, no cards or prices', st.ok && st.signed_in === false && st.viewer === 'guest' && !st.chapters && !st.prices);
}

// ---- a tiny DOM, just what subscribe.js touches ---------------------------------------------
class Node {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this.listeners = {}; this.parentNode = null; }
  get classList() { const n = this; const list = () => n.className.split(/\s+/).filter(Boolean); return { add: c => { if (!list().includes(c)) n.className = (n.className + ' ' + c).trim(); }, remove: c => { n.className = list().filter(x => x !== c).join(' '); }, contains: c => list().includes(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.children.map(c => c.nodeType === 3 ? c.text : c.textContent).join(''); }
  set textContent(v) { this.children = [{ nodeType: 3, text: String(v) }]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  focus() {}
  all() { const out = []; const walk = n => { n.children.forEach(c => { if (c.nodeType === 1) { out.push(c); walk(c); } }); }; walk(this); return out; }
  querySelector(sel) { return this.all().find(n => sel[0] === '.' ? n.classList.contains(sel.slice(1)) : n.id === sel.slice(1)) || null; }
}

const src = fs.readFileSync(path.join(root, 'assets', 'subscribe.js'), 'utf8');
const tpl = fs.readFileSync(path.join(root, 'tools', 'quiz-maker-v2', 'assets_templates', 'subscribe.js'), 'utf8');
t('assets/subscribe.js and the Quiz Maker template are the same file', src === tpl);

// Mount the panel with a cached session (or none) and a backend (fn: payload -> reply).
async function render(session, backend) {
  const head = new Node('head'), body = new Node('body');
  const mount = new Node('div'); mount.setAttribute('id', 'subscriptions'); body.appendChild(mount);
  const store = session ? { teaching_session: JSON.stringify(session) } : {};
  const sent = [];
  const document = {
    head, body, readyState: 'complete', addEventListener() {},
    createElement: tag => new Node(tag), createTextNode: s => ({ nodeType: 3, text: s }),
    getElementById: id => [head, body].map(r => r.id === id ? r : r.querySelector('#' + id)).find(Boolean) || null,
  };
  const ctx = {
    document, Promise, JSON, Object, String, setTimeout: () => 0, console,
    location: { pathname: '/programming/baccalaureate/grade-1-secondary/' },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem() {}, removeItem() {} },
    fetch: (url, init) => { const p = JSON.parse(init.body); sent.push(p); return Promise.resolve({ text: () => Promise.resolve(JSON.stringify(backend(p))) }); },
  };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  const text = mount.textContent;
  return {
    text, sent,
    signInPrompt: text.includes('سجّل الدخول برقم هاتفك'),
    cards: mount.all().filter(n => n.classList.contains('sp-card')).length,
    buyButtons: mount.all().filter(n => n.tagName === 'BUTTON' && n.textContent === 'اشتراك').length,
    preview: text.includes('معاينة المعلم'),
  };
}

const cached = (r, isAdmin) => ({ student_id: r.student_id, student_name: 'x', session_token: r.session_token, is_admin: isAdmin, role: isAdmin ? 'admin' : 'student' });
const real = p => post(p);
// What Version 74 answers: the same options, but signed_in:false for an admin and no viewer field.
const oldBackend = p => { const r = post(p); delete r.viewer; if (r.signed_in && p.student_id === adm.student_id) r.signed_in = false; return r; };

(async () => {
  let r = await render(null, real);
  t('page: signed out -> sign-in prompt, no backend call', r.signInPrompt && r.sent.length === 0 && r.cards === 0, r.text.slice(0, 200));

  r = await render(cached(adm, true), real);
  t('page: signed-in admin -> options, NOT the sign-in prompt', !r.signInPrompt && r.cards === 2, r.text.slice(0, 300));
  t('page: admin view is a preview: a note and no "اشتراك" buttons', r.preview && r.buyButtons === 0);
  t('page: the admin session was sent with the call', r.sent[0] && r.sent[0].action === 'get_subscription_options' && r.sent[0].session_token === adm.session_token);

  r = await render(cached(stu, false), real);
  t('page: signed-in student -> options with "اشتراك" buttons, no preview note', !r.signInPrompt && r.cards === 2 && r.buyButtons === 2 && !r.preview, r.text.slice(0, 300));

  r = await render(Object.assign(cached(stu, false), { session_token: 'stale' }), real);
  t('page: stale student session -> sign-in prompt again', r.signInPrompt && r.cards === 0);

  r = await render(Object.assign(cached(adm, true), { session_token: 'stale' }), real);
  t('page: stale admin session on the new backend -> sign-in prompt', r.signInPrompt && r.cards === 0);

  r = await render(cached(adm, true), oldBackend);
  t('page: admin against the old (V74) reply still gets the preview, not the sign-in prompt', !r.signInPrompt && r.preview && r.cards === 2 && r.buyButtons === 0, r.text.slice(0, 300));
  r = await render({ student_id: adm.student_id, session_token: adm.session_token, is_admin: true }, oldBackend);
  t('page: an older cached admin session with is_admin but no role works too', !r.signInPrompt && r.preview);
  r = await render(cached(stu, false), oldBackend);
  t('page: student against the old reply is unchanged (buy buttons)', !r.signInPrompt && r.buyButtons === 2);

  console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})();
