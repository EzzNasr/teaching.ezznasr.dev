"""theme.py - the Quiz Maker's look: the site's palette (style.css / assets/base.css), Segoe UI, flat cards.

Two parts:
  apply(root)   once at startup: fonts, ttk styles (Combobox, Treeview, Progressbar, a tab-less Notebook...).
  skin(widget)  walks a widget tree and restyles plain tk widgets in place, so the tabs' building code
                does not have to change:
                  LabelFrame                -> a white card with a thin border and a bold title
                  Button, bold font         -> primary (blue)
                  Button, dark red text     -> danger (red outline look)
                  any other Button          -> secondary (soft blue-grey)
                  small grey Label          -> hint text that wraps to the card's width
                  Entry / Text / Listbox    -> flat, white, a 1 px border that turns blue on focus
New dialogs (Toplevel) are skinned when they first appear (see apply()). Widgets that set `_themed = True`
are left alone (the sidebar draws itself). Pure styling: no command, variable or layout logic changes here.
"""
import tkinter as tk
from tkinter import font as tkfont
from tkinter import messagebox, ttk

P = {
    "bg": "#f4f7fb", "panel": "#ffffff", "panel_soft": "#eef4fb", "line": "#d6e1ef", "line_strong": "#b8c9df",
    "ink": "#10233f", "ink_dim": "#63738a", "accent": "#2f6fed", "accent_strong": "#2056bd",
    "accent_soft": "#dce9ff", "danger": "#c0392b", "danger_strong": "#9e2b20", "danger_soft": "#fdecea",
    "success": "#1fae6b", "warn": "#e5a94f",
    "nav": "#10233f", "nav_hover": "#1b3558", "nav_active": "#25467a", "nav_ink": "#c9d6ea", "nav_dim": "#7f93b0",
}
DANGER_FGS = {"#8a1f1f", "#8b1a1a"}
PRIMARY_TEXTS = {"Save", "Save question", "Add questions", "Recover", "OK"}   # the main button of a dialog
HINT_FGS = {"gray30", "grey30", "#4d4d4d"}

FAMILY = "TkDefaultFont"
FONTS = {}


def _pick_family(root):
    fams = set(tkfont.families(root))
    for f in ("Segoe UI", "Helvetica Neue", "Inter", "Ubuntu", "DejaVu Sans"):
        if f in fams:
            return f
    return "TkDefaultFont"


def apply(root):
    """Fonts and ttk styles for the whole app. Call once, right after creating the Tk root."""
    global FAMILY
    FAMILY = _pick_family(root)
    for name, size, weight in (("TkDefaultFont", 10, "normal"), ("TkTextFont", 10, "normal"),
                               ("TkMenuFont", 10, "normal"), ("TkHeadingFont", 10, "bold")):
        try:
            tkfont.nametofont(name, root).configure(family=FAMILY, size=size, weight=weight)
        except tk.TclError:
            pass
    FONTS.update(
        body=(FAMILY, 10), small=(FAMILY, 9), bold=(FAMILY, 10, "bold"), card=(FAMILY, 11, "bold"),
        title=(FAMILY, 17, "bold"), subtitle=(FAMILY, 10), brand=(FAMILY, 15, "bold"), nav=(FAMILY, 11),
        caps=(FAMILY, 8, "bold"), button=(FAMILY, 10), primary=(FAMILY, 10, "bold"),
    )
    root.option_add("*Font", "TkDefaultFont")
    root.option_add("*Menu.background", P["panel"])
    root.option_add("*Menu.foreground", P["ink"])
    root.option_add("*Menu.activeBackground", P["accent_soft"])
    root.option_add("*Menu.activeForeground", P["ink"])
    root.option_add("*Menu.relief", "flat")
    root.option_add("*TCombobox*Listbox.background", P["panel"])
    root.option_add("*TCombobox*Listbox.selectBackground", P["accent_soft"])
    root.option_add("*TCombobox*Listbox.selectForeground", P["ink"])

    st = ttk.Style(root)
    if "clam" in st.theme_names():
        st.theme_use("clam")
    st.configure(".", background=P["bg"], foreground=P["ink"], font="TkDefaultFont",
                 bordercolor=P["line"], lightcolor=P["panel"], darkcolor=P["line"], troughcolor=P["panel_soft"],
                 focuscolor=P["accent"], selectbackground=P["accent_soft"], selectforeground=P["ink"])
    st.configure("TFrame", background=P["bg"])
    st.configure("TCombobox", fieldbackground=P["panel"], background=P["panel"], foreground=P["ink"],
                 arrowcolor=P["ink_dim"], bordercolor=P["line_strong"], lightcolor=P["panel"],
                 darkcolor=P["panel"], padding=(6, 4))
    st.map("TCombobox",
           fieldbackground=[("readonly", P["panel"]), ("disabled", P["panel_soft"])],
           foreground=[("readonly", P["ink"]), ("disabled", P["ink_dim"])],
           selectbackground=[("readonly", P["panel"])], selectforeground=[("readonly", P["ink"])],
           bordercolor=[("focus", P["accent"]), ("hover", P["accent"])],
           arrowcolor=[("hover", P["accent"])])
    st.configure("TCheckbutton", background=P["panel"], foreground=P["ink"])
    st.configure("Treeview", background=P["panel"], fieldbackground=P["panel"], foreground=P["ink"],
                 rowheight=28, bordercolor=P["line"], borderwidth=0)
    st.map("Treeview", background=[("selected", P["accent_soft"])], foreground=[("selected", P["ink"])])
    st.configure("Treeview.Heading", background=P["panel_soft"], foreground=P["ink_dim"], font=FONTS["bold"],
                 relief="flat", padding=(8, 6), bordercolor=P["line"])
    st.map("Treeview.Heading", background=[("active", P["accent_soft"])])
    st.configure("Vertical.TScrollbar", background=P["panel_soft"], troughcolor=P["bg"], bordercolor=P["bg"],
                 arrowcolor=P["ink_dim"], lightcolor=P["panel_soft"], darkcolor=P["panel_soft"])
    st.configure("Accent.Horizontal.TProgressbar", background=P["accent"], troughcolor=P["accent_soft"],
                 bordercolor=P["accent_soft"], lightcolor=P["accent"], darkcolor=P["accent"], thickness=6)
    # The notebook is driven by the sidebar, so its own tab row is hidden.
    st.configure("Pages.TNotebook", background=P["bg"], borderwidth=0, tabmargins=0, padding=0)
    st.layout("Pages.TNotebook.Tab", [])
    st.configure("Pages.TNotebook.Tab", padding=0)

    # Dialogs built anywhere (common.py's question dialogs, confirm boxes...) get the same look.
    root.bind_class("Toplevel", "<Map>", _skin_new_toplevel, add="+")


def _skin_new_toplevel(event):
    w = event.widget
    if isinstance(w, tk.Toplevel) and not getattr(w, "_skinned", False):
        w._skinned = True
        try:
            w.configure(bg=P["panel"])
        except tk.TclError:
            pass
        skin(w)
        # the new padding makes dialogs taller than the fixed size they were given: grow to fit, never shrink
        try:
            w.update_idletasks()
            need_w, need_h = w.winfo_reqwidth(), w.winfo_reqheight()
            have_w, have_h = w.winfo_width(), w.winfo_height()
            if need_w > have_w or need_h > have_h:
                w.geometry("%dx%d" % (max(need_w, have_w), max(need_h, have_h)))
                w.minsize(max(need_w, have_w) if need_w > have_w else 0, 0)
        except tk.TclError:
            pass


# -- skinning -------------------------------------------------------------------------------------------------

def _surface(w):
    """Background a widget sits on: white inside a card or a dialog, page background otherwise."""
    m = w.master
    while m is not None:
        s = getattr(m, "_surface", None)
        if s:
            return s
        if isinstance(m, tk.LabelFrame):
            return P["panel"]
        if isinstance(m, tk.Toplevel):
            return P["panel"]
        m = m.master
    return P["bg"]


def _font_is_bold(w):
    try:
        f = tkfont.Font(font=w.cget("font"))
        return f.actual("weight") == "bold"
    except tk.TclError:
        return False


def _font_size(w):
    try:
        return abs(tkfont.Font(font=w.cget("font")).actual("size"))
    except tk.TclError:
        return 10


def _hover(w, normal, hover):
    def enter(_e):
        if str(w.cget("state")) != "disabled":
            w.configure(bg=hover)

    def leave(_e):
        w.configure(bg=normal)
    w.bind("<Enter>", enter, add="+")
    w.bind("<Leave>", leave, add="+")


def style_button(w, kind="secondary"):
    if kind == "primary":
        bg, hov, fg = P["accent"], P["accent_strong"], "#ffffff"
        font = FONTS["primary"]
    elif kind == "danger":
        bg, hov, fg = P["danger_soft"], "#f9d6d2", P["danger"]
        font = FONTS["button"]
    elif kind == "ghost":
        bg, hov, fg = _surface(w), P["accent_soft"], P["accent_strong"]
        font = FONTS["button"]
    else:
        bg, hov, fg = P["panel_soft"], P["accent_soft"], P["ink"]
        font = FONTS["button"]
    w.configure(bg=bg, fg=fg, activebackground=hov, activeforeground=fg, relief="flat", bd=0,
                highlightthickness=0, padx=12, pady=6, cursor="hand2", font=font,
                disabledforeground=("#c7d7f7" if kind == "primary" else P["line_strong"]))
    if kind == "primary":
        w.configure(pady=8)
    _hover(w, bg, hov)
    w._themed = True


def _wrap_to_parent(label):
    """Long hint text wraps to the width it actually has, instead of being clipped at the window edge."""
    parent = label.master

    def fit(_e=None):
        try:
            px = label.pack_info().get("padx", 0)
            if isinstance(px, (tuple, list)):
                side_room = sum(int(v) for v in px)
            else:
                parts = str(px).split()
                side_room = sum(int(v) for v in parts) if len(parts) > 1 else int(parts[0] or 0) * 2
        except (tk.TclError, ValueError, IndexError):
            side_room = 16
        if isinstance(parent, tk.LabelFrame):      # the card's own inner padding and border
            try:
                side_room += 2 * int(parent.cget("padx")) + 2 * int(parent.cget("highlightthickness"))
            except (tk.TclError, ValueError):
                pass
        try:
            width = parent.winfo_width()
            if width > 40:
                label.configure(wraplength=max(200, width - side_room - 12))
        except tk.TclError:          # the label is gone (window closing)
            pass
    parent.bind("<Configure>", fit, add="+")


def _wrap_beside(label):
    """A long hint packed beside a field (side=left) wraps in the room to its right, starting at the left."""
    parent = label.master
    label.configure(anchor="w")

    def fit(_e=None):
        try:
            room = parent.winfo_width() - label.winfo_x() - 12
            if room > 60:
                label.configure(wraplength=max(160, room))
        except tk.TclError:
            pass
    parent.bind("<Configure>", fit, add="+")


def skin(widget):
    """Restyle `widget` and everything under it (see module docstring)."""
    if getattr(widget, "_themed", False):
        return
    cls = widget.winfo_class()
    surf = _surface(widget)
    try:
        if cls == "Frame":
            widget.configure(bg=getattr(widget, "_surface", None) or surf)
        elif cls == "Labelframe":
            widget._surface = P["panel"]
            title = widget.cget("text")
            widget.configure(bg=P["panel"], bd=0, relief="flat", highlightthickness=1,
                             highlightbackground=P["line"], highlightcolor=P["line"],
                             padx=10, pady=6, labelanchor="nw")
            if title:   # the title as its own padded label, so it sits inside the card, not on its edge
                lbl = tk.Label(widget, text=title, bg=P["panel"], fg=P["ink"], font=FONTS["card"],
                               padx=12, pady=8)
                lbl._themed = True
                widget.configure(labelwidget=lbl)
            if widget.winfo_manager() == "pack" and widget.master.winfo_class() == "TFrame":
                widget.pack_configure(padx=0, pady=(0, 14))      # cards on a page: even spacing
        elif cls == "Label":
            fg = str(widget.cget("fg")).lower()
            if fg in HINT_FGS or _font_size(widget) <= 8:
                preset_wrap = str(widget.cget("wraplength")) not in ("0", "")
                widget.configure(bg=surf, fg=P["ink_dim"], font=FONTS["small"], justify="left")
                stacked = widget.winfo_manager() == "pack" and widget.pack_info().get("side") == "top"
                if len(str(widget.cget("text"))) > 70 and not preset_wrap:
                    if stacked:
                        _wrap_to_parent(widget)
                    else:
                        _wrap_beside(widget)
            else:
                widget.configure(bg=surf, fg=P["ink"] if fg in ("systembuttontext", "black", "#000000") else widget.cget("fg"))
        elif cls == "Button":
            fg = str(widget.cget("fg")).lower()
            primary = _font_is_bold(widget) or str(widget.cget("text")) in PRIMARY_TEXTS
            style_button(widget, "danger" if fg in DANGER_FGS else "primary" if primary else "secondary")
        elif cls == "Menubutton":
            widget.configure(bg=P["panel_soft"], fg=P["ink"], activebackground=P["accent_soft"],
                             activeforeground=P["ink"], relief="flat", bd=0, highlightthickness=0,
                             padx=14, pady=6, cursor="hand2", font=FONTS["button"])
        elif cls == "Entry":
            widget.configure(bg=P["panel"], fg=P["ink"], relief="flat", bd=5, highlightthickness=1,
                             highlightbackground=P["line_strong"], highlightcolor=P["accent"],
                             insertbackground=P["ink"], selectbackground=P["accent_soft"],
                             selectforeground=P["ink"], disabledbackground=P["panel_soft"],
                             readonlybackground=P["panel_soft"])
        elif cls == "Text":
            widget.configure(bg=P["panel"], fg=P["ink"], relief="flat", bd=8, highlightthickness=1,
                             highlightbackground=P["line_strong"], highlightcolor=P["accent"],
                             insertbackground=P["ink"], selectbackground=P["accent_soft"],
                             selectforeground=P["ink"])
        elif cls == "Listbox":
            widget.configure(bg=P["panel"], fg=P["ink"], relief="flat", bd=6, highlightthickness=1,
                             highlightbackground=P["line_strong"], highlightcolor=P["accent"],
                             selectbackground=P["accent_soft"], selectforeground=P["ink"],
                             activestyle="none")
        elif cls in ("Checkbutton", "Radiobutton"):
            widget.configure(bg=surf, fg=P["ink"], activebackground=surf, activeforeground=P["ink"],
                             selectcolor=P["panel"], highlightthickness=0, bd=0, cursor="hand2")
        elif cls == "Canvas":
            widget.configure(bg=surf, highlightthickness=0)
        elif cls == "Scrollbar":
            widget.configure(bd=0, highlightthickness=0, width=12)
    except tk.TclError:
        pass
    for child in widget.winfo_children():
        skin(child)


class Tooltip(object):
    """A small hover note (used for the sidebar tools, whose explanations used to fill the top of the window)."""

    def __init__(self, widget, text, delay=450):
        self.widget, self.text, self.delay = widget, text, delay
        self._after = None
        self._tip = None
        widget.bind("<Enter>", self._schedule, add="+")
        widget.bind("<Leave>", self._hide, add="+")
        widget.bind("<ButtonPress>", self._hide, add="+")

    def _schedule(self, _e=None):
        self._cancel()
        self._after = self.widget.after(self.delay, self._show)

    def _cancel(self):
        if self._after:
            self.widget.after_cancel(self._after)
            self._after = None

    def _show(self):
        text = self.text() if callable(self.text) else self.text
        if not text or self._tip:
            return
        x = self.widget.winfo_rootx() + self.widget.winfo_width() + 8
        y = self.widget.winfo_rooty()
        self._tip = tw = tk.Toplevel(self.widget)
        tw._skinned = True                           # not a dialog: keep its own colours
        tw.wm_overrideredirect(True)
        tw.wm_geometry("+%d+%d" % (x, y))
        tk.Label(tw, text=text, justify="left", bg=P["ink"], fg="#ffffff", font=FONTS.get("small"),
                 wraplength=320, padx=10, pady=7).pack()

    def _hide(self, _e=None):
        self._cancel()
        if self._tip:
            self._tip.destroy()
            self._tip = None


def notify(widget, title, message, kind="success"):
    """A success message that does not need a click: a toast in the corner of the main window (app_main
    installs root._toast_host). Without a host (a test, or before the window is built) it falls back to the
    old message box. Errors and questions still use message boxes."""
    try:
        root = widget._root()
    except AttributeError:
        root = None
    host = getattr(root, "_toast_host", None)
    if host:
        host(title, message, kind)
    else:
        messagebox.showinfo(title, message)
