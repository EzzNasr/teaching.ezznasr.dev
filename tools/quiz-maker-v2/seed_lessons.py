#!/usr/bin/env python3
"""seed_lessons.py - the owner seeds empty lessons for a teacher to fill in (refactor Phase 2.5, step G).

    python tools/quiz-maker-v2/seed_lessons.py tools/quiz-maker-v2/seeds/science.json [--site <site root>]
                                                [--rewrite <group>]

Each lesson is written by the Quiz Maker's own "Generate lesson files" code (QuizTab._write_lesson_files: the lesson
templates, the stylesheets, attachments.json, upsert_lesson_card on the grade page), with no questions and no video,
then the SEO step runs once (tools/seo/seo_build.py). So the result is exactly what the app makes. The folder is
neutral, chapter-<n>-lesson-<m>; the title is the owner's. The Drive bridge is switched off while seeding (nothing is
sent to the server). A lesson folder that already exists is left alone, so running it again only adds new lessons;
--rewrite <group> writes that grade's existing lessons again from the seed file (new titles, quiz link, assignment
page), keeping each lesson's attachments.json. Videos, questions and files on the server are keyed by the folder,
so they stay with the lesson.

The seed file:
    {"subject": "science", "subject_title": "Science",
     "groups": [{"group": "preparatory/grade-3-preparatory",
                 "title_format": "Unit {chapter} | {title}",      (optional)
                 "quiz": true, "assignment": false,                (optional defaults for the grade)
                 "chapters": [{"lessons": ["Title 1", {"title": "Title 2", "quiz": false}]}, ...]}]}
A lesson is a title, or {title, quiz, assignment}. quiz: false = no Quiz link on the lesson page (quiz.html is still
written: it marks the folder as a lesson). assignment: false = no assignment page. Default title format:
"Chapter {chapter} Lesson {lesson} | {title}"; an empty title drops the " | {title}" part.
"""
import argparse
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from modules import common  # noqa: E402

DEFAULT_FORMAT = "Chapter {chapter} Lesson {lesson} | {title}"


def lesson_slug(chapter, lesson):
    return "chapter-{}-lesson-{}".format(chapter, lesson)


def lesson_title(chapter, lesson, title, fmt=DEFAULT_FORMAT):
    title = (title or "").strip()
    if not title:
        fmt = fmt.split(" | {title}")[0].split("{title}")[0].rstrip(" |")
    return fmt.format(chapter=chapter, lesson=lesson, title=title).strip()


def planned(seed):
    """[{group, slug, title, quiz, assignment}] in order."""
    out = []
    for g in seed["groups"]:
        fmt = g.get("title_format") or DEFAULT_FORMAT
        for c, chap in enumerate(g["chapters"], 1):
            for l, entry in enumerate(chap["lessons"], 1):
                e = entry if isinstance(entry, dict) else {"title": entry}
                out.append({"group": g["group"], "slug": lesson_slug(c, l), "title": lesson_title(c, l, e.get("title"), fmt),
                            "quiz": bool(e.get("quiz", g.get("quiz", True))),
                            "assignment": bool(e.get("assignment", g.get("assignment", True)))})
    return out


def seed(site_root, seed_data, log=print, rewrite=()):
    from modules.quiz_tab import QuizTab          # imports tkinter; no window is opened
    subject = seed_data["subject"]
    subject_title = seed_data.get("subject_title") or subject.title()
    saved_cfg, saved_seo = common.CONFIG_PATH, common.run_seo_build
    common.CONFIG_PATH = os.path.join(tempfile.mkdtemp(), "no-config.json")   # no Drive bridge: nothing sent
    common.run_seo_build = lambda root: None                                   # once at the end instead
    made = []
    try:
        for p in planned(seed_data):
            group, slug, title = p["group"], p["slug"], p["title"]
            lesson_dir = os.path.join(common.group_dir(site_root, subject, group), slug)
            if os.path.exists(lesson_dir) and group not in rewrite:
                log("keep  {}/{}/{}".format(subject, group, slug))
                continue
            res = QuizTab._write_lesson_files({
                "site_root": site_root, "lesson_name": title, "subject_slug": subject, "subject_title": subject_title,
                "group_relpath": group, "lesson_slug": slug, "lesson_dir": lesson_dir,
                "location_label": common.lesson_url_path(subject, group, slug), "include_assignment": p["assignment"],
                "include_quiz": p["quiz"], "questions": [], "lesson_desc": "", "assign_prompt": "", "video_url": "", "rev": 0})
            if res.get("card_error") or res.get("sync_error") or res.get("video_warning"):
                raise RuntimeError("{}: {}".format(slug, res))
            old_assignment = os.path.join(lesson_dir, "assignment.html")
            if not p["assignment"] and os.path.exists(old_assignment):
                os.remove(old_assignment)            # rewritten without an assignment: no stale page left behind
            made.append(slug)
            log("seed  {}/{}/{}  {}{}{}".format(subject, group, slug, title, "" if p["quiz"] else "  (no quiz)",
                                                "" if p["assignment"] else "  (no assignment)"))
    finally:
        common.CONFIG_PATH, common.run_seo_build = saved_cfg, saved_seo
    if made:
        common.run_seo_build(site_root)
    return made


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("seed_file")
    ap.add_argument("--site", default=os.path.abspath(os.path.join(HERE, "..", "..")))
    ap.add_argument("--rewrite", action="append", default=[], metavar="GROUP",
                    help="write this grade's existing lessons again from the seed file")
    a = ap.parse_args(argv)
    with open(a.seed_file, encoding="utf-8") as f:
        data = json.load(f)
    groups = [g["group"] for g in data["groups"]]
    bad = [g for g in a.rewrite if g not in groups]
    if bad:
        ap.error("--rewrite: not a grade in the seed file: " + ", ".join(bad))
    made = seed(a.site, data, rewrite=tuple(a.rewrite))
    print("{} lesson(s) seeded.".format(len(made)))


if __name__ == "__main__":
    main(sys.argv[1:])
