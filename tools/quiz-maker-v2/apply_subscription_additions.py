#!/usr/bin/env python3
"""
apply_subscription_additions.py — adds the three small Code.gs changes (and their tests)
that the grade-subscription pages need. Run once, from anywhere:

    python tools/quiz-maker-v2/apply_subscription_additions.py

What it does (all-or-nothing, safe to re-run — already-applied parts are skipped):
  apps_script/Code.gs
    1. get_subscription_options also returns pay_info (the payment instructions text)
    2. new admin action admin_list_lesson_tags (handler + doPost case) for the "4. Lesson Tags" tab
    3. admin_access_overview also returns year_ends (for the dashboard's approval preview)
  tests/test_subscriptions.js
    appends the tests for the three above, before the final summary line
A .bak copy of each file is written next to it before anything changes.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CODE = os.path.join(HERE, "apps_script", "Code.gs")
TESTS = os.path.join(HERE, "tests", "test_subscriptions.js")
TEST_SNIPPET = os.path.join(HERE, "test_subscriptions_additions.js.txt")

HANDLER = '''// Admin (Tkinter "Lesson Tags" tab): every tagged lesson, so the tab can show its current chapter/term.
function handleAdminListLessonTags(payload) {
  _requireAdminAny(payload);
  var map = _lessonTagsMap(_ss());
  return {
    ok: true,
    tags: Object.keys(map).sort().map(function (l) { return { lesson: l, chapter: map[l].chapter, term: map[l].term }; }),
  };
}

'''
YEAR_ENDS = '''  var yearEnds = {};
  Object.keys(GRADE_SCOPE_FOLDERS).forEach(function (base) {
    try { yearEnds[base] = _gradeYearEnd(GRADE_SCOPE_FOLDERS[base]); } catch (e) { yearEnds[base] = ""; }
  });

'''


def read(path):
    with open(path, "rb") as f:
        return f.read().decode("utf-8")


def write(path, text):
    with open(path + ".bak", "wb") as f:
        f.write(open(path, "rb").read())
    with open(path, "wb") as f:
        f.write(text.encode("utf-8"))


def once(text, needle, label):
    n = text.count(needle)
    if n != 1:
        sys.exit("STOPPED, nothing changed: expected exactly one place for %s, found %d. "
                 "Code.gs differs from what this script expects." % (label, n))


def patch_code(src):
    nl = "\r\n" if "\r\n" in src else "\n"
    text = src.replace("\r\n", "\n")
    done = []

    # 1. pay_info in get_subscription_options
    if "pay_info: _payInfo()," not in text.split("function handleRequestSubscription")[0].split("function handleGetSubscriptionOptions")[-1]:
        a = "signed_in: !!phone, year_end: _gradeYearEnd(suffix),\n"
        once(text, a, "get_subscription_options return")
        text = text.replace(a, a + "           pay_info: _payInfo(),\n")
        done.append("pay_info in get_subscription_options")

    # 2. admin_list_lesson_tags handler + dispatch
    if "function handleAdminListLessonTags" not in text:
        anchor = '// One lesson path, "some/folder/*" (everything under it), "*" (everything), or a\n'
        once(text, anchor, "handler insertion point (before _normalizeScope)")
        text = text.replace(anchor, HANDLER + anchor)
        done.append("handleAdminListLessonTags")
    if 'case "admin_list_lesson_tags":' not in text:
        case = '      case "admin_set_lesson_tags":\n        return _json(handleAdminSetLessonTags(payload));\n'
        once(text, case, "doPost case for admin_set_lesson_tags")
        text = text.replace(case, case + '\n      case "admin_list_lesson_tags":\n        return _json(handleAdminListLessonTags(payload));\n')
        done.append("doPost case admin_list_lesson_tags")

    # 3. year_ends in admin_access_overview
    if "year_ends: yearEnds" not in text:
        ret = "  return { ok: true, today: today, counts: counts, videos: videos, quizzes: quizzes, groups: groups,\n"
        tail = "lesson_locks: lessonLocks };"
        once(text, ret, "admin_access_overview return")
        once(text, tail, "admin_access_overview return end")
        text = text.replace(ret, YEAR_ENDS + ret).replace(tail, "lesson_locks: lessonLocks, year_ends: yearEnds };")
        done.append("year_ends in admin_access_overview")

    return text.replace("\n", nl), done


def patch_tests(src):
    if "chunk 4 additions" in src:
        return src, False
    nl = "\r\n" if "\r\n" in src else "\n"
    text = src.replace("\r\n", "\n")
    snippet = read(TEST_SNIPPET).replace("\r\n", "\n")
    snippet = "\n".join(l for l in snippet.split("\n") if not l.startswith("// Paste into") and not l.startswith("// test_subscriptions.js") and not l.startswith("// console.log")) .strip("\n") + "\n\n"
    m = list(re.finditer(r"^console\.log\('\\n' \+ pass", text, re.M))
    if len(m) != 1:
        sys.exit("STOPPED, nothing changed: couldn't find the final summary line in test_subscriptions.js.")
    text = text[:m[0].start()] + snippet + text[m[0].start():]
    return text.replace("\n", nl), True


def main():
    for p in (CODE,):
        if not os.path.exists(p):
            sys.exit("Not found: " + p)
    new_code, done = patch_code(read(CODE))
    new_tests, tests_done = (None, False)
    if os.path.exists(TESTS) and os.path.exists(TEST_SNIPPET):
        new_tests, tests_done = patch_tests(read(TESTS))
    elif not os.path.exists(TESTS):
        print("note: tests/test_subscriptions.js not found - skipped the tests part.")
    if done:
        write(CODE, new_code)
    if tests_done:
        write(TESTS, new_tests)
    print("Code.gs: " + (("added " + ", ".join(done)) if done else "already up to date"))
    print("test_subscriptions.js: " + ("tests appended" if tests_done else "already up to date / skipped"))
    if done:
        print("\nNext: run the tests, paste Code.gs into Apps Script, then Deploy > Manage deployments > edit > New version.")


if __name__ == "__main__":
    main()
