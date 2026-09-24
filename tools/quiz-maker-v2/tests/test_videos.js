const { load } = require('./harness');
const crypto = require('crypto');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');

const ID = 'dQw4w9WgXcQ';                       // a well-formed 11-character id
const EMBED = 'https://www.youtube.com/embed/' + ID;
const WATCH = 'https://www.youtube.com/watch?v=' + ID + '&t=5s';
const LESSON = 'programming/other/functions';
const has = (obj, s) => JSON.stringify(obj).includes(s);

const env = load(path);
const { post, getSS, cache, lockState } = env;
const videosTab = () => getSS('STU').getSheetByName('Videos');
const dataRows = () => { const sh = videosTab(); return sh ? Math.max(sh.getLastRow() - 1, 0) : 0; };
const wipeCache = () => Object.keys(cache).forEach(k => delete cache[k]);
const colOf = (sh, name) => { for (let c = 1; c <= 10; c++) if (sh.get(1, c) === name) return c; return 0; };

// ---- accounts: one admin (is_admin set by hand, like in the Sheet), one student ----
const admReg = post({ action: 'register_student', phone: '01000000001', password_hash: H('a'), display_name: 'Teacher', year: 'Senior 1', parent_phone: '01100000001' });
const stuReg = post({ action: 'register_student', phone: '01000000002', password_hash: H('b'), display_name: 'Sara', year: 'Senior 1', parent_phone: '01100000002' });
const stuSheet = getSS('STU').getSheetByName('Students');
stuSheet.set(2, colOf(stuSheet, 'is_admin'), true);
const ADMIN = { student_id: admReg.student_id, session_token: admReg.session_token };
const STUDENT = { student_id: stuReg.student_id, session_token: stuReg.session_token };
const get = (extra, slot = 'lesson', lesson = LESSON) => post(Object.assign({ action: 'get_video', lesson, slot }, extra || {}));
const set = (creds, body) => post(Object.assign({ action: 'admin_set_video' }, creds, body));

// 1. nothing configured yet ------------------------------------------------------
{
  const r = get();
  t('no Videos tab: found=false, no error', r.ok && r.found === false, JSON.stringify(r));
  t('a read never creates the Videos tab', videosTab() === null);
}

// 2. who may set a video ---------------------------------------------------------
{
  let r = set(STUDENT, { lesson: LESSON, slot: 'lesson', video_url: WATCH });
  t('a normal student cannot set a video', !r.ok && /Not authorized/.test(r.error), JSON.stringify(r));
  r = set({ token: 'wrong' }, { lesson: LESSON, slot: 'lesson', video_url: WATCH });
  t('wrong desktop token is refused', !r.ok && /Not authorized/.test(r.error), JSON.stringify(r));
  r = set({}, { lesson: LESSON, slot: 'lesson', video_url: WATCH });
  t('no credentials at all is refused', !r.ok, JSON.stringify(r));
  t('refused calls create nothing', videosTab() === null);

  r = set({ token: 'tok' }, { lesson: LESSON, slot: 'lesson', video_url: WATCH });
  t('desktop token can set a video', r.ok, JSON.stringify(r));
  t('watch link is normalised to an embed URL', r.embed_url === EMBED, r.embed_url);
  t('a NEW video starts locked', r.locked === true, JSON.stringify(r));
  t('exactly one row written', dataRows() === 1, dataRows());
}

// 3. who can see a locked video --------------------------------------------------
{
  let r = get();
  t('logged out: locked, need login', r.ok && r.found && r.locked && r.need === 'login', JSON.stringify(r));
  t('logged out: the URL is NOT in the response', !has(r, ID), JSON.stringify(r));
  r = get(STUDENT);
  t('signed-in student (no access yet): need payment', r.locked && r.need === 'payment', JSON.stringify(r));
  t('signed-in student: the URL is NOT in the response', !has(r, ID), JSON.stringify(r));
  r = get({ student_id: STUDENT.student_id, session_token: 'stale-token' });
  t('stale session counts as logged out', r.locked && r.need === 'login' && !has(r, ID), JSON.stringify(r));
  r = get({ student_id: '01099999999', session_token: 'x' });
  t('unknown student id counts as logged out (no error)', r.ok && r.need === 'login' && !has(r, ID), JSON.stringify(r));
  r = get(ADMIN);
  t('admin session can preview a locked video', r.ok && r.locked && r.embed_url === EMBED, JSON.stringify(r));
  r = get({}, 'lesson', '/Programming/Other/Functions/');
  t('same slot however the path is written', r.found && r.locked, JSON.stringify(r));
}

// 4. the toggle -------------------------------------------------------------------
{
  get();                                        // primes the cache with the LOCKED state
  let r = set(ADMIN, { lesson: LESSON, slot: 'lesson', locked: false });
  t('admin session can unlock', r.ok && r.locked === false && r.embed_url === EMBED, JSON.stringify(r));
  t('toggling does not add a row', dataRows() === 1, dataRows());
  r = get();
  t('unlocked: anyone (logged out) gets the URL, right away', r.ok && r.locked === false && r.embed_url === EMBED, JSON.stringify(r));
  r = set({ token: 'tok' }, { lesson: LESSON, slot: 'lesson', locked: true });
  r = get();
  t('locking again hides the URL again, right away', r.locked && !has(r, ID), JSON.stringify(r));
}

// 5. the lock fails closed --------------------------------------------------------
{
  const sh = videosTab(), lc = colOf(sh, 'locked');
  const check = (cell, expectLocked) => {
    sh.set(2, lc, cell); wipeCache();
    const r = get();
    t('locked cell ' + JSON.stringify(cell) + ' -> ' + (expectLocked ? 'stays locked' : 'opens'), expectLocked ? (r.locked && !has(r, ID)) : (r.locked === false && r.embed_url === EMBED), JSON.stringify(r));
  };
  check('', true); check('TRUE', true); check(true, true); check('nope', true); check('maybe later', true);
  check(false, false); check('FALSE', false); check(' false ', false);
  sh.set(2, lc, true); wipeCache();
}

// 6. three independent slots ------------------------------------------------------
{
  let r = set(ADMIN, { lesson: LESSON, slot: 'quiz', video_url: 'https://youtu.be/aaaaaaaaaaa?si=xyz' });
  t('quiz slot created, locked by default', r.ok && r.locked === true && r.embed_url === 'https://www.youtube.com/embed/aaaaaaaaaaa', JSON.stringify(r));
  r = set(ADMIN, { lesson: LESSON, slot: 'assignment', video_url: 'https://www.youtube.com/shorts/bbbbbbbbbbb', locked: false });
  t('assignment slot can be created already open', r.ok && r.locked === false, JSON.stringify(r));
  t('three slots = three rows', dataRows() === 3, dataRows());
  t('lesson slot is unaffected by the others', get().locked === true && !has(get(), ID));
  t('quiz slot is locked for a logged-out visitor', get({}, 'quiz').locked === true);
  t('assignment slot is open for a logged-out visitor', get({}, 'assignment').locked === false);
  r = set(ADMIN, { lesson: LESSON, slot: 'lesson', video_url: 'https://youtu.be/ccccccccccc' });
  t('replacing a URL updates the row, no duplicate', r.ok && dataRows() === 3 && r.embed_url === 'https://www.youtube.com/embed/ccccccccccc', JSON.stringify(r));
  t('replacing a URL keeps the lock state', r.locked === true, JSON.stringify(r));
  t('other lessons are separate', get({}, 'lesson', 'programming/other/if-conditional').found === false);
}

// 7. bad input --------------------------------------------------------------------
{
  const bad = (name, body) => { const r = set(ADMIN, body); t(name, !r.ok, JSON.stringify(r)); };
  bad('unknown slot name', { lesson: LESSON, slot: 'main', video_url: WATCH });
  bad('path traversal in lesson', { lesson: '../etc/passwd', slot: 'lesson', video_url: WATCH });
  bad('empty lesson', { lesson: '', slot: 'lesson', video_url: WATCH });
  bad('random website', { lesson: LESSON, slot: 'lesson', video_url: 'https://evil.example/video' });
  bad('javascript: URL', { lesson: LESSON, slot: 'lesson', video_url: 'javascript:alert(1)' });
  bad('too-short YouTube id (embed)', { lesson: LESSON, slot: 'lesson', video_url: 'https://www.youtube.com/embed/short' });
  bad('too-short YouTube id (watch)', { lesson: LESSON, slot: 'lesson', video_url: 'https://www.youtube.com/watch?v=short' });
  bad('quote injected after a valid embed URL', { lesson: LESSON, slot: 'lesson', video_url: EMBED + '"onload=alert(1)' });
  bad('nothing to change', { lesson: LESSON, slot: 'lesson' });
  bad('lock a slot that has no video', { lesson: 'programming/other/if-conditional', slot: 'lesson', locked: true });
  const r = set(ADMIN, { lesson: LESSON, slot: 'lesson', video_url: 'https://player.vimeo.com/video/123456789?h=abcdef1234', locked: true });
  t('a Vimeo player URL is accepted', r.ok && /player\.vimeo\.com/.test(r.embed_url), JSON.stringify(r));
  t('bad input changed nothing', dataRows() === 3, dataRows());
  set(ADMIN, { lesson: LESSON, slot: 'lesson', video_url: WATCH });
}

// 8. clearing ---------------------------------------------------------------------
{
  let r = set(ADMIN, { lesson: LESSON, slot: 'quiz', video_url: '' });
  t('blank video_url clears the slot', r.ok && r.cleared === true && dataRows() === 2, JSON.stringify(r));
  t('cleared slot is "not found" again', get({}, 'quiz').found === false);
  t('rows below the cleared one moved up intact', get({}, 'assignment').embed_url === 'https://www.youtube.com/embed/bbbbbbbbbbb' && get(ADMIN).embed_url === EMBED);
  r = set(ADMIN, { lesson: LESSON, slot: 'quiz', video_url: '' });
  t('clearing an empty slot is harmless', r.ok && r.cleared === false && dataRows() === 2, JSON.stringify(r));
}

// 9. listing ----------------------------------------------------------------------
{
  let r = post(Object.assign({ action: 'admin_list_videos' }, STUDENT));
  t('a normal student cannot list videos', !r.ok && !has(r, ID), JSON.stringify(r));
  r = post({ action: 'admin_list_videos' });
  t('listing with no credentials is refused', !r.ok);
  r = post(Object.assign({ action: 'admin_list_videos' }, ADMIN));
  t('admin session lists every slot', r.ok && r.videos.length === 2 && r.videos.every(v => v.lesson && v.slot && v.embed_url && typeof v.locked === 'boolean'), JSON.stringify(r));
  r = post({ action: 'admin_list_videos', token: 'tok' });
  t('desktop token can list too', r.ok && r.videos.length === 2, JSON.stringify(r));
}

// 10. busy lock / damaged sheet ---------------------------------------------------
{
  lockState.busy = true;
  let r = set(ADMIN, { lesson: LESSON, slot: 'lesson', locked: false });
  t('busy lock: a change is retryable, not lost silently', !r.ok && r.retryable === true, JSON.stringify(r));
  r = get();
  t('busy lock: students can still load videos (reads take no lock)', r.ok && r.found, JSON.stringify(r));
  lockState.busy = false;

  const sh = videosTab(), ec = colOf(sh, 'embed_url');
  sh.set(1, ec, 'oops'); wipeCache();
  r = get();
  t('a damaged Videos header gives a readable error and no URL', !r.ok && /Videos sheet is missing/.test(r.error) && !has(r, ID), JSON.stringify(r));
  sh.set(1, ec, 'embed_url'); wipeCache();
  t('fixing the header fixes it', get().ok);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
