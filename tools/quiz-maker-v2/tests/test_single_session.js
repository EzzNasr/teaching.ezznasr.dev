// One active session per account: a student login signs out the previous device.
const { load } = require('./harness');
const crypto = require('crypto');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');

const ID = 'dQw4w9WgXcQ';
const LESSON = 'programming/other/functions';
const env = load(path);
const { post, getSS } = env;
const colOf = (sh, name) => { for (let c = 1; c <= 12; c++) if (sh.get(1, c) === name) return c; return 0; };

const reg = (phone, pw, name) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 1', parent_phone: '011' + phone.slice(3) });
const login = (phone, pw) => post({ action: 'login_student', phone, password_hash: H(pw) });
const get = creds => post(Object.assign({ action: 'get_video', lesson: LESSON, slot: 'lesson' }, creds || {}));

const stuReg = reg('01000000002', 'b', 'Sara');
const admReg = reg('01000000001', 'a', 'Teacher');
const sheet = getSS('STU').getSheetByName('Students');
// find the admin row and flag it by hand, like in the Sheet
for (let r = 2; r <= sheet.getLastRow(); r++) if (String(sheet.get(r, colOf(sheet, 'phone'))).replace(/\D/g, '').endsWith('1000000001')) sheet.set(r, colOf(sheet, 'is_admin'), true);
post({ action: 'admin_set_video', token: 'tok', lesson: LESSON, slot: 'lesson', video_url: 'https://www.youtube.com/watch?v=' + ID });

// student: second login replaces the first
const phone = { student_id: stuReg.student_id };
const a = login('01000000002', 'b');
const b = login('01000000002', 'b');
t('both logins succeed', a.ok && b.ok, JSON.stringify([a, b]));
t('second login gets a different token', a.session_token !== b.session_token);
t('token from registration is dead after login', !!get(Object.assign({}, phone, { session_token: stuReg.session_token })).session_replaced);
t('first device is told it was replaced', get(Object.assign({}, phone, { session_token: a.session_token })).session_replaced === true);
t('replaced session sees no video URL', !JSON.stringify(get(Object.assign({}, phone, { session_token: a.session_token }))).includes(ID));
t('replaced session still asks for login', get(Object.assign({}, phone, { session_token: a.session_token })).need === 'login');
const ok = get(Object.assign({}, phone, { session_token: b.session_token }));
t('newest session is treated as signed in (payment, not login)', ok.need === 'payment', JSON.stringify(ok));
t('newest session is not flagged as replaced', !ok.session_replaced);

// a real dashboard call with the dead token is refused
const dead = post({ action: 'get_my_results', student_id: a.student_id, session_token: a.session_token });
t('dashboard call with replaced token is refused', !dead.ok && /expired or invalid/i.test(dead.error), JSON.stringify(dead));
t('dashboard call with the newest token works', post({ action: 'get_my_results', student_id: b.student_id, session_token: b.session_token }).ok);

// never signed in / unknown account are not "replaced"
t('no session: plain login prompt', get().need === 'login' && !get().session_replaced);
t('unknown account: plain login prompt, no error', (r => r.ok && r.need === 'login' && !r.session_replaced)(get({ student_id: '01099999999', session_token: 'x' })));

// admin keeps one token across logins (teacher uses several devices)
const a1 = login('01000000001', 'a');
const a2 = login('01000000001', 'a');
t('admin login keeps the same token', a1.ok && a2.ok && a1.session_token === a2.session_token && a1.session_token === admReg.session_token, JSON.stringify([a1.session_token, a2.session_token]));
t('admin session still works after a second login', !!post({ action: 'admin_list_videos', student_id: a1.student_id, session_token: a1.session_token }).ok);

// wrong password must NOT sign anyone out
const before = login('01000000002', 'b');
login('01000000002', 'wrong');
t('a wrong-password attempt does not sign out the real device', get(Object.assign({}, phone, { session_token: before.session_token })).need === 'payment');

// password reset still rotates
const rs = post({ action: 'reset_password', phone: '01000000002', parent_phone: '01100000002', new_password_hash: H('c') });
t('reset signs out the current device (and says so)', rs.ok && get(Object.assign({}, phone, { session_token: before.session_token })).session_replaced === true, JSON.stringify(rs));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
