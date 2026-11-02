#!/usr/bin/env python3
"""
teacher_mode.py - subject-limited "teacher mode" for the desktop Quiz Maker (Phase 4, session S4).

A teacher pastes HIS OWN token into `drive_admin_token`. The server's `ping` answers
{ok, kind, subjects, name} (Phase 4 contract section 6). This module:

  * turns that answer into an `identity`,
  * filters `common.SUBJECTS` IN PLACE so every tab only offers the teacher's subjects
    (call it BEFORE the tabs are built; they read SUBJECTS once, at construction),
  * remembers the allowed subjects so drive_bridge can refuse other subjects early
    (a convenience and a clear message only: the server is the real boundary),
  * produces the badge text shown in the app.

Stdlib only, no tkinter, so it is unit-testable. An old backend (no `kind` in the ping answer) or an owner
token means "no restriction": nothing is filtered and nothing is refused.
"""

_FULL_SUBJECTS = {}      # id(list) -> original (slug, label) pairs, so apply() can be re-run with a new token
_STATE = {"restricted": False, "allowed": None, "identity": None}
KNOWN_SUBJECTS = ("programming", "english", "math")


class TeacherModeError(Exception):
    """Raised by guard_subject() when a restricted teacher asks for a subject outside his scope."""


def identity_from_ping(resp):
    """Normalise a `ping` response. -> {"kind","subjects","name","known"}.
    known=False means the backend does not report who the caller is (pre-Phase 4): treated as the owner."""
    resp = resp if isinstance(resp, dict) else {}
    kind = str(resp.get("kind") or "").lower()
    subjects = resp.get("subjects")
    if kind and isinstance(subjects, (list, tuple)):
        return {"kind": kind, "subjects": [str(s).lower() for s in subjects],
                "name": str(resp.get("name") or ""), "known": True}
    return {"kind": "owner", "subjects": ["*"], "name": "", "known": False}


def is_restricted(identity):
    if not identity:
        return False
    return identity["kind"] == "teacher" and "*" not in identity["subjects"]


def filter_subjects(subjects, identity):
    """Keep only the teacher's subjects in `subjects` (a list of (slug, label)), IN PLACE.
    Returns the list of slugs that were hidden. Never leaves the list empty: if the teacher's scope matches
    none of the known subjects the list is left alone and [] is returned (the caller shows the problem)."""
    full = _FULL_SUBJECTS.setdefault(id(subjects), list(subjects))
    subjects[:] = full                       # always start from the full list (re-apply with a new token)
    if not is_restricted(identity):
        return []
    keep = [(s, l) for s, l in full if s in identity["subjects"]]
    if not keep:
        return []
    hidden = [s for s, _ in full if s not in identity["subjects"]]
    subjects[:] = keep
    return hidden


def apply(identity, subjects):
    """Set the module state from `identity` and filter `subjects` in place. -> status dict."""
    hidden = filter_subjects(subjects, identity)
    restricted = is_restricted(identity)
    if restricted and not hidden and len(subjects) != 1 and \
            not any(s in identity["subjects"] for s, _ in subjects):
        # scope has no subject this app knows: stay open, say so, the server still refuses everything
        status = {"restricted": True, "problem": "Your token's subjects (%s) are not subjects this app knows."
                  % ", ".join(identity["subjects"])}
        _STATE.update(restricted=False, allowed=None, identity=identity)
        return status
    _STATE.update(restricted=restricted, allowed=list(identity["subjects"]) if restricted else None,
                  identity=identity)
    return {"restricted": restricted, "hidden": hidden, "shown": [s for s, _ in subjects]}


def reset():
    _STATE.update(restricted=False, allowed=None, identity=None)


def current_identity():
    return _STATE["identity"]


def subject_of(value):
    """'math/chapter-1/lesson-2' -> 'math'; 'math' -> 'math'; anything not starting with a known subject -> ''."""
    first = str(value or "").strip().strip("/").split("/")[0].split("#")[0].strip().lower()
    return first if first in KNOWN_SUBJECTS else ""


def allowed(subject_or_lesson):
    """True when the value is outside the restriction, or no restriction is active, or it is not a known subject."""
    if not _STATE["restricted"]:
        return True
    sub = subject_of(subject_or_lesson)
    return sub == "" or sub in _STATE["allowed"]


def guard_subject(subject_or_lesson):
    if not allowed(subject_or_lesson):
        raise TeacherModeError("Your teacher token only covers %s, not %s."
                               % (", ".join(_STATE["allowed"]), subject_of(subject_or_lesson)))


def badge_text(identity):
    if not identity or not identity.get("known"):
        return ""
    if identity["kind"] == "teacher":
        scope = ", ".join(identity["subjects"]) or "no subjects"
        return "Teacher mode: %s (%s)" % (identity["name"] or "teacher", scope)
    if identity["kind"] == "owner":
        return "Owner token (all subjects)"
    return "Signed in as %s" % identity["kind"]


def fetch_identity(web_app_url, token, timeout=8):
    """Ping the Drive bridge and return the identity. Raises drive_bridge.DriveBridgeError on failure."""
    from . import drive_bridge          # local import: drive_bridge imports this module for its guards
    return identity_from_ping(drive_bridge._post_json(web_app_url, {"action": "ping", "token": token}, timeout=timeout))


def startup(config_data, subjects, get_drive_config):
    """One call for app_main: read the Drive config, ping, filter `subjects`, return
    (identity or None, badge text, problem text). Never raises: an unreachable server means no filtering
    and a badge that says so."""
    cfg = get_drive_config(config_data)
    if not cfg["web_app_url"] or not cfg["admin_token"]:
        reset()
        return None, "", ""
    try:
        ident = fetch_identity(cfg["web_app_url"], cfg["admin_token"])
    except Exception as e:                                   # network, HTTP, bad token: stay open, server decides
        reset()
        return None, "Could not verify the token (%s); subjects are not limited here." % str(e).splitlines()[0][:90], ""
    status = apply(ident, subjects)
    return ident, badge_text(ident), status.get("problem", "")
