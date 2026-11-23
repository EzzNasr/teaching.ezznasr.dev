// R-P25-G: the teacher fills in the owner's lessons from his browser (Phase 2.5 step G, dashboard/my-lessons.html).
//   node tests/test_p25_lessons_browser.js        (run from tools/quiz-maker-v2)
// Through the real doPost (Code.gs + Phase 4): a teacher's dashboard SESSION may now save quiz questions, written
// models, upload and delete files and keep a lesson's file list on the server (admin_set_attachments), only in his
// subjects; get_attachments is public. The list keeps the attachments.json shape; a teacher may only add files uploaded
// for his subjects (files already listed may stay); students, scoped assistants and anonymous callers cannot write.
const { makeWorld, setStudent, S1PHONE, TOKEN } = require('./test_p4_s4_support');
let fails = 0, passes = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 500))); ok ? passes++ : fails++; };
const J = o => JSON.stringify(o);
const NA = r => !!r && r.ok === false && r.error === 'Not authorized.';
const W = makeWorld();
const { api, post } = W;
const as = (who, p) => post(Object.assign({}, p, who));
api.env.props.ATTACHMENTS_FOLDER_ID = 'ATTFOLDER';
// The fake Drive has no parents: every file it makes sits in the attachments folder.
// (and the fake blob ignores setName, so the stamped name <subject>--<lesson>--<id>--<file> is set here, as Drive would)
const inFolder = (r, subject, lesson) => { const f = api.env.drive.files.find(x => x.id === r.file_id); if (f) { f.id = r.file_id = '1fake' + f.id.padStart(20, 'x'); f.name = [subject, lesson.replace(/[^a-zA-Z0-9._-]+/g, '-'), 'abcd1234', 'sheet.pdf'].join('--'); } if (f) f.getParents = () => { let n = 0; return { hasNext: () => n === 0, next: () => (n++, { getId: () => 'ATTFOLDER' }) }; }; return r; };
const M = 'math/test-course/lesson-1', P = 'programming/test-course/lesson-1';
const b64 = Buffer.from('%PDF-1.4 hello').toString('base64');
const upload = (who, subject, lesson) => inFolder(as(who, { action: 'upload_attachment', subject, lesson, filename: 'sheet.pdf', mime_type: 'application/pdf', data_base64: b64 }), subject, lesson);

// ---------------------------------------------------------------- quiz questions from the browser
const quiz = { title: 'Chapter 1 Lesson 1', subject: 'math', lesson: 'lesson-1', questions: [{ type: 'tf', q: 'Water boils at 100 C.', answer: true }] };
let r = as(W.T, { action: 'admin_set_quiz_content', lesson: M, content_json: J(quiz) });
t('teacher session saves quiz questions on his lesson', r.ok === true, J(r));
r = as(W.T, { action: 'admin_get_quiz_content', lesson: M });
t('teacher session reads them back', r.ok === true && r.quiz && r.quiz.questions.length === 1, J(r));
t('refused: quiz questions on another subject', NA(as(W.T, { action: 'admin_set_quiz_content', lesson: P, content_json: J(quiz) })));
t('refused: reading another subject\'s questions', NA(as(W.T, { action: 'admin_get_quiz_content', lesson: P })));
r = as(W.T, { action: 'admin_set_written_models', lesson: M, models: [{ question_id: 'w1', max_marks: 2, model_answer: 'x', prompt: 'p' }] });
t('teacher session saves written-answer models on his lesson', r.ok === true, J(r));
t('refused: a student saving quiz questions', (x => x.ok === false)(as(W.S1, { action: 'admin_set_quiz_content', lesson: M, content_json: J(quiz) })));
t('refused: his scoped assistant saving quiz questions', NA(as(W.A, { action: 'admin_set_quiz_content', lesson: M, content_json: J(quiz) })));
t('the desktop teacher token still works', post({ action: 'admin_get_quiz_content', token: TOKEN, lesson: M }).ok === true);

// ---------------------------------------------------------------- files
const up = upload(W.T, 'math', M);
t('teacher session uploads a file for his lesson', up.ok === true && !!up.file_id, J(up));
t('refused: uploading for another subject', NA(upload(W.T, 'programming', P)));
t('refused: uploading with a lesson of another subject', NA(upload(W.T, 'math', P)));
t('refused: a student uploading', (x => x.ok === false)(upload(W.S1, 'math', M)));

const item = id => ({ title: 'Worksheet', drive_file_id: id, type: 'pdf', section: 'lesson' });
r = as(W.T, { action: 'admin_set_attachments', lesson: M, items: [item(up.file_id)] });
t('teacher session saves the lesson\'s file list', r.ok === true && r.items.length === 1, J(r));
r = post({ action: 'get_attachments', lesson: M });
t('anyone reads the list (the lesson page)', r.ok === true && J(r.items) === J([item(up.file_id)]), J(r));
t('an unknown lesson has an empty list', J(post({ action: 'get_attachments', lesson: 'math/none/x' }).items) === '[]');
t('refused: a bad lesson key', post({ action: 'get_attachments', lesson: '../x' }).ok === false);

const foreign = upload({ token: 'tok' }, 'programming', P);
t('the owner uploads for programming (desktop token)', foreign.ok === true, J(foreign));
t('refused: the math teacher listing a programming file', NA(as(W.T, { action: 'admin_set_attachments', lesson: M, items: [item(up.file_id), item(foreign.file_id)] })));
t('refused: a Drive id that is not an uploaded attachment', NA(as(W.T, { action: 'admin_set_attachments', lesson: M, items: [item('1zaxQFvbs2wp7Xq9NPWUYDQVca66W8tQh')] })));
t('refused: a list for another subject\'s lesson', NA(as(W.T, { action: 'admin_set_attachments', lesson: P, items: [] })));
t('refused: a student saving a list', (x => x.ok === false)(as(W.S1, { action: 'admin_set_attachments', lesson: M, items: [] })));
t('refused: his scoped assistant saving a list', NA(as(W.A, { action: 'admin_set_attachments', lesson: M, items: [] })));
t('refused: no credentials', post({ action: 'admin_set_attachments', lesson: M, items: [] }).ok === false);

// the owner's own files on the list may stay when the teacher reorders or renames
r = post({ action: 'admin_set_attachments', token: 'tok', lesson: M, items: [item(up.file_id), item('1OWNERfileAAAAAAAAAAAA')] });
t('the owner adds any Drive id', r.ok === true, J(r));
r = as(W.T, { action: 'admin_set_attachments', lesson: M, items: [Object.assign(item('1OWNERfileAAAAAAAAAAAA'), { title: 'Renamed' }), item(up.file_id)] });
t('the teacher may keep, reorder and retitle files already on the list', r.ok === true && r.items[0].title === 'Renamed', J(r));

const bad = items => as(W.T, { action: 'admin_set_attachments', lesson: M, items });
t('refused: not a list', bad({ title: 'x' }).ok === false);
t('refused: a bad Drive id', bad([item('javascript:alert(1)')]).ok === false);
t('refused: a bad type', bad([{ title: 'x', drive_file_id: up.file_id, type: '<b>' }]).ok === false);
t('a file for the quiz page and one for the assignment page are kept with their section', (x => x.ok === true && x.items[0].section === 'quiz' && x.items[1].section === 'assignment')(bad([Object.assign(item(up.file_id), { section: 'quiz' }), Object.assign(item(up.file_id), { section: 'assignment' })])));
t('a file without a section belongs to the lesson page', (x => x.ok === true && x.items[0].section === 'lesson')(bad([{ title: 'x', drive_file_id: up.file_id, type: 'pdf' }])));
t('refused: an unknown section', bad([Object.assign(item(up.file_id), { section: 'home' })]).ok === false);
t('refused: more than 40 files', bad(Array.from({ length: 41 }, () => item(up.file_id))).ok === false);
r = bad([{ title: '  <b>x</b>\u0001 ', drive_file_id: up.file_id, type: 'PDF', extra: 'dropped' }]);
t('titles are trimmed, types lowered, other fields dropped (rendered as text by the page)', r.ok === true && J(r.items) === J([{ title: '<b>x</b>', drive_file_id: up.file_id, type: 'pdf', section: 'lesson' }]), J(r));
t('the list was not changed by the refused saves', post({ action: 'get_attachments', lesson: M }).items[0].title === '<b>x</b>');

// delete
t('teacher session deletes his file', as(W.T, { action: 'delete_attachment', file_id: up.file_id }).ok === true && api.env.drive.files.find(f => f.id === up.file_id).trashed === true);
t('refused: deleting another subject\'s file', NA(as(W.T, { action: 'delete_attachment', file_id: foreign.file_id })));

// a second teacher (science) never reaches math
const SPHONE = '01055550199';
const reg = api.post({ action: 'register_student', phone: SPHONE, password_hash: api.H('pw'), display_name: 'Science Teacher', year: 'Senior 2', parent_phone: '01234567890' });
setStudent(api, SPHONE, { role: 'teacher', teacher_scope: 'science' });
const SCI = { student_id: reg.student_id, session_token: reg.session_token };
t('a science teacher signs in', reg.ok === true && !!reg.session_token, J(reg));
t('science teacher: his own lesson works', as(SCI, { action: 'admin_set_attachments', lesson: 'science/secondary/grade-1-secondary/chapter-1-lesson-1', items: [] }).ok === true);
t('science teacher: refused on math', NA(as(SCI, { action: 'admin_set_attachments', lesson: M, items: [] })) && NA(as(SCI, { action: 'admin_set_quiz_content', lesson: M, content_json: J(quiz) })));
void S1PHONE;

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
