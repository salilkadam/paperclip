"""Materialize a scene spec (template + props) into a standalone editable HTML file."""
import copy
import os
import re

from . import tmpl

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "templates")

_ICON = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
         'stroke-linecap="round" stroke-linejoin="round" width="100%%" height="100%%">%s</svg>')

ICONS = {
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "alert": '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
    "chart": '<path d="M3 20h18"/><rect x="5" y="11" width="3" height="7"/><rect x="11" y="6" width="3" height="12"/><rect x="17" y="14" width="3" height="4"/>',
    "bolt": '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
    "shield": '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="m9 12 2 2 4-4"/>',
    "users": '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M17 11a3 3 0 1 0-2-5.2"/><path d="M18 20a5 5 0 0 0-3-4.6"/>',
    "money": '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5a2.5 2.5 0 0 1 5 0c0 2.5-5 1.5-5 4a2.5 2.5 0 0 0 5 0"/>',
    "search": '<circle cx="11" cy="11" r="6"/><path d="m20 20-3.5-3.5"/>',
    "cloud": '<path d="M7 18a4 4 0 0 1 .6-8 5 5 0 0 1 9.5 1.4A3.5 3.5 0 0 1 17 18H7z"/>',
    "spark": '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
    "check": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    "gear": '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    "doc": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5M9 14h6M9 17h4"/>',
    "link": '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
    "target": '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6"/>',
}

DEFAULTS = {
    "statement": {"align": "center"},
    "solution_reveal": {"side": "wide-left"},
    "feature_grid": {"cols": 3},
    "ui_walkthrough": {"url": "yourproduct.com", "callout_at": 1.4,
                       "rows": [{"w": 70, "accent": True}, {"w": 92}, {"w": 84}, {"w": 60}]},
    "phone_walkthrough": {"rows": [{"w": 80, "accent": True}, {"w": 95}, {"w": 70}, {"w": 88}]},
    "comparison": {"before_title": "Today", "after_title": "With us"},
}

STAT_DEFAULTS = {"from": 0, "prefix": "", "suffix": "", "dp": 0, "comma": 1, "at": 0.5, "dur": 1.6}


def load_catalogue():
    """templates/scenes.html -> {name: body_html}"""
    raw = open(os.path.join(TEMPLATES_DIR, "scenes.html")).read()
    parts = re.split(r"<!--\s*@template\s+(\w+)(.*?)-->", raw, flags=re.S)
    out = {}
    for i in range(1, len(parts), 3):
        out[parts[i]] = parts[i + 2].strip()
    return out


def template_names():
    return sorted(load_catalogue())


def _icons(props):
    for key in ("items", "steps"):
        for item in props.get(key) or []:
            if isinstance(item, dict):
                name = item.get("icon") or "check"
                item["icon_svg"] = _ICON % ICONS.get(name, ICONS["check"])
    return props


def _fill_stats(props):
    stats = props.get("stats")
    if stats:
        for i, s in enumerate(stats):
            for k, v in STAT_DEFAULTS.items():
                s.setdefault(k, v)
            if s["at"] == STAT_DEFAULTS["at"]:
                s["at"] = 0.5 + 0.25 * i
    m = props.get("metric")
    if isinstance(m, dict):
        for k, v in STAT_DEFAULTS.items():
            m.setdefault(k, v)
    return props


def materialize(project, scene, out_path=None):
    """Render scene -> standalone HTML. Returns the path written."""
    cat = load_catalogue()
    name = scene.get("template")
    if name not in cat:
        raise KeyError("unknown template %r. Available: %s" % (name, ", ".join(sorted(cat))))

    theme = project.theme()
    # Deep copy: the fill helpers below add icon_svg and stat defaults, and
    # mutating the scene's own props would change its recipe hash on every
    # build — making every scene permanently "stale".
    props = copy.deepcopy(DEFAULTS.get(name, {}))
    props.update(copy.deepcopy(scene.get("props") or {}))
    props = _fill_stats(_icons(props))

    ctx = dict(props)
    ctx.update({
        "theme": theme,
        "width": project.data["width"],
        "height": project.data["height"],
        "mode": "light" if theme.get("mode") == "light" else "",
        "id": scene["id"],
        "template": name,
        "duration": scene.get("duration") or 6,
        "project_title": project.data.get("title", ""),
        "caption": scene.get("caption"),
        "sub": scene.get("sub"),
        "logo": scene.get("logo") or (project.data.get("logo") if scene.get("show_logo", True) else None),
        "logo_pos": scene.get("logo_pos", ""),
        "grid": scene.get("grid", True),
        "art": scene.get("art") or props.get("art"),
    })

    css = tmpl.render(open(os.path.join(TEMPLATES_DIR, "theme.css")).read(), ctx)
    body_tpl = cat[name]
    scene_css = ""
    m = re.search(r"<style>(.*?)</style>", body_tpl, re.S)
    if m:
        scene_css = tmpl.render(m.group(1), ctx)
        body_tpl = body_tpl.replace(m.group(0), "")

    ctx["css"] = css
    ctx["scene_css"] = scene_css
    ctx["engine"] = open(os.path.join(TEMPLATES_DIR, "engine.js")).read()
    ctx["body"] = tmpl.render(body_tpl, ctx)

    html = tmpl.render(open(os.path.join(TEMPLATES_DIR, "shell.html")).read(), ctx)
    out_path = out_path or project.p("scenes", scene["id"] + ".html")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        f.write(html)
    return out_path
