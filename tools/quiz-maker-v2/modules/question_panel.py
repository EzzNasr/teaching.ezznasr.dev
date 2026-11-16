"""question_panel.py - the question list used by the Quiz page and the Assignment page's graded questions.

A table (number, chapter, type, question) where you select as many rows as you like - click, Shift+click a
range, Ctrl+click to add or drop one, Ctrl+A for all - and then act on all of them at once:

    Edit (one row)      Duplicate      Move up / down      Set chapter      Keep only these      Remove

Keys while the list has focus: Delete removes, Ctrl+D duplicates, Alt+Up / Alt+Down move, Enter edits,
Ctrl+A selects all, Esc clears the selection. Every change goes through before_change() first, so the page's
Ctrl+Z undo covers it. The list operations themselves are in modules/qlist.py (tested without tkinter).
"""
import tkinter as tk
from tkinter import ttk

from modules import qlist, theme


class QuestionPanel(tk.Frame):
    def __init__(self, parent, get_items, set_items, on_edit, before_change, status_var, new_qid=None,
                 chapters=range(1, 21), height=9):
        super().__init__(parent)
        self._get, self._set, self._on_edit = get_items, set_items, on_edit
        self._before, self._status, self._new_qid = before_change, status_var, new_qid
        P = theme.P

        top = tk.Frame(self)
        top.pack(fill="x", pady=(0, 6))
        self.summary_var = tk.StringVar(value=qlist.summary([]))
        self._summary = tk.Label(top, textvariable=self.summary_var, anchor="w", font=theme.FONTS.get("bold"),
                                 bg=P["panel"], fg=P["ink"])
        self._summary.pack(side="left")
        self._summary._themed = True
        self.clear_btn = tk.Button(top, text="Clear selection", command=self.clear_selection)
        self.all_btn = tk.Button(top, text="Select all", command=self.select_all)
        for b in (self.clear_btn, self.all_btn):
            theme.style_button(b, "ghost")
            b.configure(padx=8, pady=2)
            b.pack(side="right")

        table = tk.Frame(self)
        table.pack(fill="both", expand=True)
        cols = ("n", "ch", "type", "q")
        self.tree = ttk.Treeview(table, columns=cols, show="headings", selectmode="extended", height=height,
                                 style="Questions.Treeview")
        for col, label, width, stretch, anchor in (("n", "#", 44, False, "e"), ("ch", "Chapter", 84, False, "center"),
                                                   ("type", "Type", 80, False, "w"), ("q", "Question", 400, True, "w")):
            self.tree.heading(col, text=label, anchor=anchor if col != "n" else "e")
            self.tree.column(col, width=width, minwidth=40, stretch=stretch, anchor=anchor)
        self.tree.tag_configure("odd", background="#f8fafd")
        sb = ttk.Scrollbar(table, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self._empty = tk.Label(table, text="No questions yet — add some with the buttons above, or paste "
                                           "a whole set with “Bulk paste”.",
                               bg=P["panel"], fg=P["ink_dim"], font=theme.FONTS.get("body"))
        self._empty._themed = True

        bar = tk.Frame(self)
        bar.pack(fill="x", pady=(8, 0))
        self.sel_var = tk.StringVar(value="")
        self.edit_btn = tk.Button(bar, text="✎  Edit", command=self.edit_selected)
        self.dup_btn = tk.Button(bar, text="⎘  Duplicate", command=self.duplicate_selected)
        self.up_btn = tk.Button(bar, text="↑", command=lambda: self.move_selected(-1), width=3)
        self.down_btn = tk.Button(bar, text="↓", command=lambda: self.move_selected(1), width=3)
        self.chapter_btn = tk.Menubutton(bar, text="Chapter ▾")
        menu = tk.Menu(self.chapter_btn, tearoff=0)
        for c in chapters:
            menu.add_command(label="Chapter %d" % c, command=lambda c=c: self.set_chapter_selected(c))
        self.chapter_btn.configure(menu=menu)
        self.keep_btn = tk.Button(bar, text="Keep only selected", command=self.keep_selected)
        self.remove_btn = tk.Button(bar, text="Remove selected", command=self.remove_selected, fg="#8a1f1f")
        for w, pad in ((self.edit_btn, 0), (self.dup_btn, 6), (self.up_btn, 6), (self.down_btn, 2),
                       (self.chapter_btn, 6)):
            w.pack(side="left", padx=(pad, 0))
        self.remove_btn.pack(side="right")
        self.keep_btn.pack(side="right", padx=(0, 6))
        tk.Label(bar, textvariable=self.sel_var, fg="gray30", font=("TkDefaultFont", 8)).pack(side="left", padx=10)
        self._tips = [
            theme.Tooltip(self.edit_btn, "Edit the selected question (Enter or double-click)"),
            theme.Tooltip(self.dup_btn, "Copy the selected questions (Ctrl+D)"),
            theme.Tooltip(self.up_btn, "Move the selected questions up (Alt+↑)"),
            theme.Tooltip(self.down_btn, "Move the selected questions down (Alt+↓)"),
            theme.Tooltip(self.chapter_btn, "Give all selected questions one chapter"),
            theme.Tooltip(self.keep_btn, "Remove every question that is NOT selected"),
            theme.Tooltip(self.remove_btn, "Remove the selected questions (Delete). Ctrl+Z brings them back."),
        ]

        t = self.tree
        t.bind("<<TreeviewSelect>>", lambda _e: self._update_buttons())
        t.bind("<Double-1>", lambda e: self.edit_selected() if t.identify_row(e.y) else None)
        t.bind("<Return>", lambda _e: self.edit_selected())
        t.bind("<Delete>", lambda _e: self.remove_selected())
        t.bind("<BackSpace>", lambda _e: self.remove_selected())
        t.bind("<Control-a>", lambda _e: (self.select_all(), "break")[1])
        t.bind("<Control-d>", lambda _e: (self.duplicate_selected(), "break")[1])
        t.bind("<Alt-Up>", lambda _e: (self.move_selected(-1), "break")[1])
        t.bind("<Alt-Down>", lambda _e: (self.move_selected(1), "break")[1])
        t.bind("<Escape>", lambda _e: self.clear_selection())
        self.refresh()

    # -- state ---------------------------------------------------------------------------------------------

    def selection(self):
        """Selected row indexes, top to bottom."""
        return sorted(int(i) for i in self.tree.selection())

    def refresh(self, select=None):
        items = self._get()
        keep = self.selection() if select is None else select
        self.tree.delete(*self.tree.get_children())
        for i, q in enumerate(items):
            self.tree.insert("", "end", iid=str(i), values=qlist.row(i, q), tags=("odd",) if i % 2 else ())
        keep = [str(i) for i in keep if 0 <= i < len(items)]
        if keep:
            self.tree.selection_set(keep)
            self.tree.see(keep[0])
        self.summary_var.set(qlist.summary(items))
        if items:
            self._empty.place_forget()
        else:
            self._empty.place(relx=0.5, rely=0.55, anchor="center")
        self._update_buttons()

    def _update_buttons(self):
        n, total = len(self.tree.selection()), len(self._get())
        def state(ok):
            return "normal" if ok else "disabled"
        self.edit_btn.configure(state=state(n == 1))
        for b in (self.dup_btn, self.up_btn, self.down_btn, self.chapter_btn, self.remove_btn):
            b.configure(state=state(n >= 1))
        self.keep_btn.configure(state=state(0 < n < total))
        self.clear_btn.configure(state=state(n >= 1))
        self.all_btn.configure(state=state(total > 0 and n < total))
        self.remove_btn.configure(text="Remove selected" if n <= 1 else "Remove %d selected" % n)
        self.sel_var.set("" if not n else ("1 selected" if n == 1 else "%d selected" % n))

    def select_all(self):
        self.tree.selection_set(self.tree.get_children())
        self.tree.focus_set()

    def clear_selection(self):
        self.tree.selection_set(())

    # -- actions -------------------------------------------------------------------------------------------

    def _apply(self, result, message):
        items, sel = result
        self._before()
        self._set(items)
        self.refresh(select=sel)
        self.tree.focus_set()
        if message:
            self._status.set(message)

    def _need(self, what):
        sel = self.selection()
        if not sel:
            self._status.set("Select one or more questions first, then {}.".format(what))
            self.bell()
        return sel

    def edit_selected(self):
        sel = self.selection()
        if len(sel) != 1:
            self._status.set("Select exactly one question to edit." if sel else "Select a question to edit.")
            return
        self._on_edit(sel[0])

    def remove_selected(self):
        sel = self._need("Remove")
        if sel:
            n = len(sel)
            self._apply(qlist.remove(self._get(), sel),
                        "Removed {} question{} — Ctrl+Z to undo.".format(n, "" if n == 1 else "s"))

    def keep_selected(self):
        sel = self._need("Keep only selected")
        if sel:
            dropped = len(self._get()) - len(sel)
            self._apply(qlist.keep_only(self._get(), sel),
                        "Kept {} question(s), removed {} — Ctrl+Z to undo.".format(len(sel), dropped))

    def duplicate_selected(self):
        sel = self._need("Duplicate")
        if sel:
            self._apply(qlist.duplicate(self._get(), sel, new_qid=self._new_qid),
                        "Duplicated {} question(s); the copies are selected.".format(len(sel)))

    def move_selected(self, delta):
        sel = self._need("move them")
        if sel:
            items, new_sel = qlist.move(self._get(), sel, delta)
            if new_sel != sel:
                self._apply((items, new_sel), "")

    def set_chapter_selected(self, chapter):
        sel = self._need("set the chapter")
        if sel:
            self._apply(qlist.set_chapter(self._get(), sel, chapter),
                        "Set chapter {} on {} question(s).".format(chapter, len(sel)))
