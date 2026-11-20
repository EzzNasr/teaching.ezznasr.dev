"""qlist.py - operations on a question list (Quiz page questions, Assignment page graded questions).

Pure functions on a list of question dicts and a set of selected indexes: they never change their input and
return (new_list, new_selection) so the panel can keep the same rows selected after a move or duplicate.
No tkinter, so tests/test_question_list.py checks them directly. The widget is modules/question_panel.py.
"""
import copy

TYPE_LABELS = {"mcq": "MCQ", "truefalse": "T/F", "match": "Match", "written": "Written"}


def _norm(idxs, n):
    return sorted({int(i) for i in idxs if 0 <= int(i) < n})


def remove(items, idxs):
    """-> (items without the selected ones, [])."""
    gone = set(_norm(idxs, len(items)))
    return [q for i, q in enumerate(items) if i not in gone], []


def keep_only(items, idxs):
    """The opposite of remove: keep the selected questions, drop the rest. -> (items, all indexes)."""
    keep = _norm(idxs, len(items))
    return [items[i] for i in keep], list(range(len(keep)))


def duplicate(items, idxs, new_qid=None):
    """Copy each selected question right after the last selected one, in order. A written question's copy
    gets a fresh qid (its id pairs photos, model answer and marks on the server, so two must never share one).
    -> (items, indexes of the copies)."""
    sel = _norm(idxs, len(items))
    if not sel:
        return list(items), []
    copies = []
    for i in sel:
        c = copy.deepcopy(items[i])
        if isinstance(c, dict) and c.get("type") == "written" and new_qid is not None:
            c["qid"] = new_qid()
        copies.append(c)
    at = sel[-1] + 1
    out = list(items[:at]) + copies + list(items[at:])
    return out, list(range(at, at + len(copies)))


def move(items, idxs, delta):
    """Move the selected questions up (delta=-1) or down (+1) by one place, as a group; a block already at the
    top/bottom stays. -> (items, new indexes of the moved questions)."""
    n = len(items)
    sel = _norm(idxs, n)
    if not sel or delta == 0:
        return list(items), sel
    out = list(items)
    if delta < 0:
        if sel[0] == 0:
            return out, sel
        for i in sel:                       # top to bottom: swap each with the row above it
            out[i - 1], out[i] = out[i], out[i - 1]
        return out, [i - 1 for i in sel]
    if sel[-1] == n - 1:
        return out, sel
    for i in reversed(sel):                 # bottom to top: swap each with the row below it
        out[i + 1], out[i] = out[i], out[i + 1]
    return out, [i + 1 for i in sel]


def move_to(items, idxs, where):
    """Move the selected questions to the top ("top") or the bottom ("bottom"), keeping their order."""
    sel = _norm(idxs, len(items))
    if not sel:
        return list(items), []
    picked = [items[i] for i in sel]
    rest = [q for i, q in enumerate(items) if i not in set(sel)]
    if where == "top":
        return picked + rest, list(range(len(picked)))
    return rest + picked, list(range(len(rest), len(rest) + len(picked)))


def set_chapter(items, idxs, chapter):
    """Give every selected question this chapter. -> (items, same selection)."""
    sel = _norm(idxs, len(items))
    out = [copy.deepcopy(q) if i in set(sel) else q for i, q in enumerate(items)]
    for i in sel:
        out[i]["chapter"] = chapter
    return out, sel


def prompt_of(q):
    return str(q.get("prompt", q.get("q", "")) or "")


def row(i, q):
    """(number, chapter, type label, one-line question) for one row of the list."""
    chapter = q.get("chapter")
    text = " ".join(prompt_of(q).split())
    return (str(i + 1), "" if chapter is None else str(chapter), TYPE_LABELS.get(q.get("type", "mcq"), "?"),
            text[:140] + ("…" if len(text) > 140 else ""))


def summary(items):
    """'12 questions · 8 MCQ, 2 T/F, 2 Written · chapters 1–3' (or 'No questions yet')."""
    if not items:
        return "No questions yet"
    counts = {}
    for q in items:
        label = TYPE_LABELS.get(q.get("type", "mcq"), "Other")
        counts[label] = counts.get(label, 0) + 1
    order = [lbl for lbl in TYPE_LABELS.values() if lbl in counts] + [k for k in counts if k not in TYPE_LABELS.values()]
    parts = ["{} question{}".format(len(items), "" if len(items) == 1 else "s"),
             ", ".join("{} {}".format(counts[k], k) for k in order)]
    chapters = sorted({q.get("chapter") for q in items if isinstance(q.get("chapter"), int)})
    if chapters:
        parts.append("chapter {}".format(chapters[0]) if len(chapters) == 1
                     else "chapters {}–{}".format(chapters[0], chapters[-1]))
    return " · ".join(parts)
