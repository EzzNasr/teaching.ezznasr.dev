#!/usr/bin/env python3
"""seed_lessons.py - the owner seeds empty lessons for a teacher to fill in (refactor Phase 2.5, step G).

    python tools/quiz-maker-v2/seed_lessons.py tools/quiz-maker-v2/seeds/science.json [--site <site root>]

Each lesson is written by the Quiz Maker's own "Generate lesson files" code (QuizTab._write_lesson_files: the lesson
templates, the stylesheets, attachments.json, upsert_lesson_card on the grade page), with no questions and no video,
then the SEO step runs once (tools/seo/seo_build.py). So the result is exactly what the app makes. The folder is
neutral, chapter-<n>-lesson-<m>; the title is the owner's. The Drive bridge is switched off while seeding (nothing is
sent to the server). A lesson folder that already exists is left alone, so running it again only adds new lessons.

The seed file:
    {"subject": "science", "subject_title": "Science",
     "groups": [{"group": "preparatory/grade-3-preparatory",
                 "chapters": [{"lessons": ["Title of lesson 1", "Title of lesson 2"]}, ...]}]}
A lesson is shown as "Chapter <n> Lesson <m> | <title>" (or "Chapter <n> Lesson <m>" when the title is empty).
"""
import argparse
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from modules import common  # noqa: E402


def lesson_slug(chapter, lesson):
    return "chapter-{}-lesson-{}".format(chapter, lesson)


def lesson_title(chapter, lesson, title):
    head = "Chapter {} Lesson {}".format(chapter, lesson)
    return "{} | {}".format(head, title.strip()) if title and title.strip() else head


def planned(seed):
    """[(group, slug, title)] in order."""
    out = []
    for g in seed["groups"]:
        for c, chap in enumerate(g["chapters"], 1):
            for l, title in enumerate(chap["lessons"], 1):
                out.append((g["group"], lesson_slug(c, l), lesson_title(c, l, title)))
    return out


def seed(site_root, seed_data, log=print):
    from modules.quiz_tab import QuizTab          # imports tkinter; no window is opened
    subject = seed_data["subject"]
    subject_title = seed_data.get("subject_title") or subject.title()
    saved_cfg, saved_seo = common.CONFIG_PATH, common.run_seo_build
    common.CONFIG_PATH = os.path.join(tempfile.mkdtemp(), "no-config.json")   # no Drive bridge: nothing sent
    common.run_seo_build = lambda root: None                                   # once at the end instead
    made = []
    try:
        for group, slug, title in planned(seed_data):
            lesson_dir = os.path.join(common.group_dir(site_root, subject, group), slug)
            if os.path.exists(lesson_dir):
                log("keep  {}/{}/{}".format(subject, group, slug))
                continue
            res = QuizTab._write_lesson_files({
                "site_root": site_root, "lesson_name": title, "subject_slug": subject, "subject_title": subject_title,
                "group_relpath": group, "lesson_slug": slug, "lesson_dir": lesson_dir,
                "location_label": common.lesson_url_path(subject, group, slug), "include_assignment": True,
                "questions": [], "lesson_desc": "", "assign_prompt": "", "video_url": "", "rev": 0})
            if res.get("card_error") or res.get("sync_error") or res.get("video_warning"):
                raise RuntimeError("{}: {}".format(slug, res))
            made.append(slug)
            log("seed  {}/{}/{}  {}".format(subject, group, slug, title))
    finally:
        common.CONFIG_PATH, common.run_seo_build = saved_cfg, saved_seo
    if made:
        common.run_seo_build(site_root)
    return made


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("seed_file")
    ap.add_argument("--site", default=os.path.abspath(os.path.join(HERE, "..", "..")))
    a = ap.parse_args(argv)
    with open(a.seed_file, encoding="utf-8") as f:
        data = json.load(f)
    made = seed(a.site, data)
    print("{} lesson(s) seeded.".format(len(made)))


if __name__ == "__main__":
    main(sys.argv[1:])
