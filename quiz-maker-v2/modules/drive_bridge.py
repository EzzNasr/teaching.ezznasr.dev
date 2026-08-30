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
