#!/usr/bin/env python3
"""
migrate_video_slots.py — video-lock pipeline fix, Session A / item A2.

Standalone, one-off script — not part of the desktop app's UI. Safe to
re-run; every step here is idempotent (a page already migrated/tagged is
just skipped the second time). Two things happen per lesson page, both
gated behind --apply (default is a dry run that writes nothing anywhere):

  1. VIDEO MIGRATION — for a page whose <div class="media-slot"> still has
     a raw, public <iframe> baked in (from before this whole lock system
     existed), register that video with the backend's Videos sheet via
     drive_bridge.set_video(..., locked=True), then clear the slot back to
     the placeholder so the public HTML never carries a live embed for
     that slot again. A teacher unlocks it from dashboard/access.html once
     they've confirmed the migration looks right.

  2. SCRIPT-TAG RETROFIT — adds <script src="/assets/video.js"></script>
     right after the page's existing auth.js tag, if it isn't already
     there. This half was NOT explicitly called for in the original
     two-track plan, but is required for the plan to actually work:
     templates/*.html were fixed (Session A, item A1) to include video.js
     going forward, but that only affects lessons generated FROM NOW ON —
     sync_site_assets() never touches already-generated lesson HTML (see
     PROJECT_REFERENCE.md's note on the "fourth sync gap"). Without this
     retrofit, every page step 1 "migrates" would go from showing a real
     (if unprotected) video to showing NOTHING at all, because nothing on
     the page would ever call get_video to redraw it. A lesson with no
     video today that gets one added later straight from the dashboard
     needs this tag too, so it's added to every lesson page found, not
     just ones with a video in them right now.

Usage:
    python3 migrate_video_slots.py                  # dry run, uses configured site_root
    python3 migrate_video_slots.py --apply           # do it for real
    python3 migrate_video_slots.py --site-root PATH  # override the configured site_root
    python3 migrate_video_slots.py --log PATH         # choose where the audit log goes

Requires the Drive bridge to already be configured (Configure... dialog in
the app, or quiz_maker_config.json's drive_web_app_url/drive_admin_token) —
needed to call admin_set_video for step 1. Step 2 (the tag retrofit) runs
regardless of whether the Drive bridge is configured, since it doesn't
call the backend.
"""

import argparse
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from modules import common, drive_bridge  # noqa: E402


SLOT_FOR_FILENAME = {"index.html": "lesson", "quiz.html": "quiz", "assignment.html": "assignment"}
SCRIPT_TAG_LINE = '<script src="/assets/video.js"></script>'
AUTH_TAG_RE = re.compile(r'(<script src="/assets/auth\.js"></script>)', re.IGNORECASE)
SKIP_DIRS = {".git", "assets", "icons", "tools", "dashboard", "__pycache__", "_deleted-lessons"}


def find_lesson_pages(site_root):
    """Yield (html_path, slot, lesson_url_path) for every index/quiz/
    assignment.html inside a real lesson folder under site_root. A "real
    lesson folder" is any directory containing a quiz.html — the same
    signature common.py itself uses elsewhere (see list_existing_lessons)."""
    for dirpath, dirnames, filenames in os.walk(site_root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        if "quiz.html" not in filenames:
            continue
        rel = os.path.relpath(dirpath, site_root).replace(os.sep, "/")
        if rel == ".":
            continue  # site_root itself is never a lesson folder
        lesson = rel
        for filename, slot in SLOT_FOR_FILENAME.items():
            if filename in filenames:
                yield os.path.join(dirpath, filename), slot, lesson


def lesson_title_from_path(lesson_path):
    slug = lesson_path.rsplit("/", 1)[-1]
    return slug.replace("-", " ").title()


def tag_status(html_path):
    """"needs-tag" | "already-present" | "no-anchor" — whether/how this
    page can have the video.js tag safely inserted."""
    with open(html_path, "r", encoding="utf-8") as f:
        content = f.read()
    if "/assets/video.js" in content:
        return "already-present", content
    if not AUTH_TAG_RE.search(content):
        return "no-anchor", content
    return "needs-tag", content


def apply_tag(html_path, content):
    new_content = AUTH_TAG_RE.sub(lambda m: m.group(1) + "\n" + SCRIPT_TAG_LINE, content, count=1)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(new_content)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site-root", help="Path to the site repo (defaults to quiz_maker_config.json's site_root)")
    ap.add_argument("--apply", action="store_true",
                     help="Actually write files / call the backend. Without this: dry run, nothing written anywhere.")
    ap.add_argument("--log", default=None,
                     help="Path for the audit log (default: migrate_video_slots_<timestamp>.log next to this script)")
    args = ap.parse_args()

    cfg = common.load_config()
    site_root = args.site_root or cfg.get("site_root", "")
    if not site_root or not os.path.isdir(site_root):
        print("No valid site root. Pass --site-root PATH, or set it via the app first.")
        sys.exit(1)

    drive_cfg = common.get_drive_config(cfg)
    have_drive_bridge = bool(drive_cfg["web_app_url"] and drive_cfg["admin_token"])
    if not have_drive_bridge:
        print("WARNING: Drive bridge isn't configured (quiz_maker_config.json is missing "
              "drive_web_app_url/drive_admin_token). Video migration (step 1) will be SKIPPED "
              "for every lesson found; the video.js script-tag retrofit (step 2) will still run, "
              "since it doesn't need the backend. Configure the Drive bridge and re-run for step 1.")

    log_path = args.log or os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "migrate_video_slots_{}.log".format(time.strftime("%Y%m%d-%H%M%S")))

    mode = "APPLY" if args.apply else "DRY RUN"
    lines = ["Video slot migration — {} — site_root={}".format(mode, site_root), ""]

    migrated = tagged = skipped_no_anchor = errors = 0

    for html_path, slot, lesson in sorted(find_lesson_pages(site_root)):
        rel_path = os.path.relpath(html_path, site_root)

        # --- 1. migrate a baked-in video, if any, into the Videos sheet ---
        video_url = ""
        try:
            video_url = common.read_media_slot_url(html_path)
        except Exception as e:
            lines.append("ERROR  {}  -- couldn't read media slot: {}".format(rel_path, e))
            errors += 1

        if video_url:
            if not have_drive_bridge:
                lines.append("SKIP   {}  [{}]  {}  -- Drive bridge not configured, not migrated".format(
                    rel_path, slot, video_url))
            else:
                lines.append("VIDEO  {}  [{}]  {}  -> registering as locked, then clearing the page".format(
                    rel_path, slot, video_url))
                if args.apply:
                    try:
                        drive_bridge.set_video(drive_cfg["web_app_url"], drive_cfg["admin_token"],
                                                lesson, slot, video_url, locked=True)
                        common.update_media_slot(html_path, "", lesson_title_from_path(lesson))
                        migrated += 1
                    except drive_bridge.DriveBridgeError as e:
                        lines.append("  ERROR registering with the backend: {} -- page left UNCHANGED".format(e))
                        errors += 1
                else:
                    migrated += 1  # counted for the dry-run summary; nothing written

        # --- 2. retrofit the video.js script tag (every lesson page, not just ones with a video) ---
        status, content = tag_status(html_path)
        if status == "needs-tag":
            tagged += 1
            lines.append("TAG    {}  -- adding <script src=\"/assets/video.js\">".format(rel_path))
            if args.apply:
                apply_tag(html_path, content)
        elif status == "no-anchor":
            skipped_no_anchor += 1
            lines.append("SKIP   {}  -- no auth.js tag found to anchor on, needs a manual look".format(rel_path))
        # "already-present": nothing to do, not logged (would be noisy for every already-migrated page)

    summary = ("\n{} summary -- {} video(s) migrated, {} page(s) tagged with video.js, "
               "{} skipped (no auth.js anchor), {} error(s)").format(
        mode, migrated, tagged, skipped_no_anchor, errors)
    lines.append(summary)

    with open(log_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print("\n".join(lines))
    print("\nLog written to: {}".format(log_path))
    if not args.apply:
        print("\nThis was a DRY RUN -- nothing was written or sent anywhere. Re-run with --apply to do it for real.")


if __name__ == "__main__":
    main()
