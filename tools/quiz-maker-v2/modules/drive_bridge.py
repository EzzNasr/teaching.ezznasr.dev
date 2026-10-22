#!/usr/bin/env python3
"""
drive_bridge.py — thin client for the Apps Script Web App (see
apps_script/Code.gs) that proxies uploads into your own Google Drive.
Stdlib only (urllib), so no extra pip installs are needed for the exe.
"""

import base64
import json
import mimetypes
import os
import urllib.error
import urllib.request


class DriveBridgeError(Exception):
    pass


def _post_json(web_app_url, payload, timeout=30):
    if not web_app_url:
        raise DriveBridgeError("Drive bridge isn't configured yet. Set the Web App URL first.")

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        web_app_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise DriveBridgeError("Drive bridge returned HTTP {}: {}".format(e.code, e.read().decode("utf-8", "ignore")))
    except urllib.error.URLError as e:
        raise DriveBridgeError("Couldn't reach the Drive bridge URL: {}".format(e.reason))

    try:
        data = json.loads(raw)
    except ValueError:
        raise DriveBridgeError("Drive bridge returned something that wasn't JSON:\n" + raw[:400])

    if not data.get("ok"):
        raise DriveBridgeError(data.get("error", "Drive bridge reported an unknown error."))
    return data


def upload_attachment(web_app_url, admin_token, subject, lesson, file_path, title):
    """Admin-only: push a file into the ATTACHMENTS Drive folder (configured
    server-side in Code.gs). Returns {"file_id": ..., "view_url": ...}."""
    filename = os.path.basename(file_path)
    mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    with open(file_path, "rb") as f:
        data_b64 = base64.b64encode(f.read()).decode("ascii")

    payload = {
        "action": "upload_attachment",
        "token": admin_token,
        "subject": subject,
        "lesson": lesson,
        "filename": filename,
        "mime_type": mime_type,
        "title": title or filename,
        "data_base64": data_b64,
    }
    return _post_json(web_app_url, payload)


def delete_attachment(web_app_url, admin_token, file_id):
    payload = {"action": "delete_attachment", "token": admin_token, "file_id": file_id}
    return _post_json(web_app_url, payload)


def test_connection(web_app_url, admin_token):
    payload = {"action": "ping", "token": admin_token}
    return _post_json(web_app_url, payload)


# -- Videos: locked/unlocked lesson videos, see Code.gs's "Videos" section --
# admin_set_video/get_video/admin_list_videos are already implemented and
# deployed server-side; this is just a thin client for them, matching the
# upload_attachment/delete_attachment pattern above.

def set_video(web_app_url, admin_token, lesson, slot, video_url, locked=None):
    """Admin-only: add/update/clear a (lesson, slot) row in the Videos
    sheet. video_url: a link (adds/replaces), or "" to clear the slot.
    locked: True/False, or leave as None to leave an existing row's lock
    state untouched (a brand-new row then starts locked, server-side
    default — see admin_set_video in Code.gs)."""
    payload = {
        "action": "admin_set_video",
        "token": admin_token,
        "lesson": lesson,
        "slot": slot,
        "video_url": video_url,
    }
    if locked is not None:
        payload["locked"] = locked
    return _post_json(web_app_url, payload)


def list_videos(web_app_url, admin_token):
    """Admin-only: every row in the Videos sheet, as a list of
    {"lesson", "slot", "embed_url", "locked", "updated_at"} dicts."""
    payload = {"action": "admin_list_videos", "token": admin_token}
    return _post_json(web_app_url, payload)


def get_video(web_app_url, admin_token, lesson, slot):
    """Admin-only convenience: the Videos-sheet row for one (lesson, slot),
    as {"lesson", "slot", "embed_url", "locked", "updated_at"}, or None if
    nothing is set there yet. There's no single-row admin lookup action
    server-side (get_video there is the public, session-gated one), so
    this pulls the full list and filters — fine at the size this sheet is
    expected to stay at."""
    lesson = str(lesson or "").strip().lower().strip("/")
    slot = str(slot or "").strip().lower()
    result = list_videos(web_app_url, admin_token)
    for row in result.get("videos", []):
        if str(row.get("lesson", "")).strip().lower() == lesson and \
           str(row.get("slot", "")).strip().lower() == slot:
            return row
    return None


def set_quiz_content(web_app_url, admin_token, lesson, quiz_json):
    """Admin-only: upsert the full quiz object (title/subject/lesson/questions,
    with correct answers) into the backend's QuizContent sheet, keyed by
    lesson. This is what get_quiz reads at view time — the questions never
    need to be baked into quiz.html's own source once this has run, the same
    way a video's URL doesn't need to be baked in once set_video has run."""
    payload = {
        "action": "admin_set_quiz_content",
        "token": admin_token,
        "lesson": lesson,
        "content_json": json.dumps(quiz_json),
    }
    return _post_json(web_app_url, payload)


def get_quiz_content(web_app_url, admin_token, lesson):
    """Admin-only: the full quiz object currently stored server-side for
    lesson (title/subject/lesson/questions), regardless of whether the quiz
    is locked — unlike the public get_quiz action, which withholds it while
    locked. Returns None if nothing has been synced there yet. Used when
    reopening a lesson for editing, so a synced lesson's question list still
    shows even though it's no longer baked into quiz.html."""
    payload = {"action": "admin_get_quiz_content", "token": admin_token, "lesson": lesson}
    result = _post_json(web_app_url, payload)
    return result.get("quiz")
