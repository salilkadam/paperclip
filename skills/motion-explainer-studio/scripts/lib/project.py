"""Project state, artifact dependency tracking and hand-edit detection.

The project directory IS the state. Every stage writes plain files a human can
open and edit; `Project` only records what each artifact was built FROM, so the
next run can rebuild exactly what went stale and nothing else.

Layout of a project dir:

    <project>/
      project.json        canonical state: theme, scenes, voice, timings
      research.md         stage 1 output (human-written or ingested)
      script.md           stage 2 output, human-editable mirror of scene VO
      assets/             art, logo, screenshots
      vo/sNN.wav          stage 4 voiceover, one file per scene
      scenes/sNN.html     stage 5 materialized scene, standalone + editable
      clips/sNN.mp4       stage 6 rendered scene video (silent)
      music.mp3
      final.mp4
      review.html         the dashboard
      .build/             hashes, frames, logs (safe to delete)
"""
import json
import hashlib
import os
import shutil
import time

STAGES = ["research", "script", "vo", "art", "scene", "render", "assemble"]


def _h(*parts):
    m = hashlib.sha256()
    for p in parts:
        if p is None:
            p = ""
        if not isinstance(p, (str, bytes)):
            p = json.dumps(p, sort_keys=True, default=str)
        if isinstance(p, str):
            p = p.encode("utf-8")
        m.update(p)
        m.update(b"\x00")
    return m.hexdigest()[:16]


def file_hash(path):
    if not os.path.exists(path):
        return None
    m = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            m.update(chunk)
    return m.hexdigest()[:16]


DEFAULT_THEME = {
    "bg": "#0E1117",
    "surface": "#161B26",
    "ink": "#FFFFFF",
    "muted": "#9AA4B2",
    "brand": "#4F7CFF",
    "accent": "#FF7A59",
    "ok": "#2DD4A7",
    "warn": "#FFC53D",
    "font_head": "Inter, 'Helvetica Neue', Arial, sans-serif",
    "font_body": "Inter, 'Helvetica Neue', Arial, sans-serif",
    "radius": 28,
    "mode": "dark",
}


class Project:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.path = os.path.join(self.root, "project.json")
        self.data = {}
        if os.path.exists(self.path):
            with open(self.path) as f:
                self.data = json.load(f)

    # ---------- lifecycle ----------
    @classmethod
    def create(cls, root, title, **kw):
        p = cls(root)
        for d in ("assets", "vo", "scenes", "clips", ".build"):
            os.makedirs(os.path.join(p.root, d), exist_ok=True)
        p.data = {
            "title": title,
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "source": kw.get("source"),
            "audience": kw.get("audience"),
            "tone": kw.get("tone", "confident, friendly, modern"),
            "target_seconds": kw.get("target_seconds", 75),
            "fps": kw.get("fps", 30),
            "width": kw.get("width", 1920),
            "height": kw.get("height", 1080),
            "voice": kw.get("voice", "Jessica"),
            "tempo": kw.get("tempo", 1.0),
            "vo_takes": kw.get("vo_takes", 5),
            "music_tags": kw.get("music_tags",
                                 "upbeat corporate explainer, light plucks, warm pads, no vocals"),
            "music_volume": 0.5,
            "tail": 0.45,
            "transition": {"type": "fade", "seconds": 0.5},
            "theme": dict(DEFAULT_THEME),
            "scenes": [],
            "stages": {},
            "notes": [],
        }
        p.save()
        return p

    def save(self):
        with open(self.path, "w") as f:
            json.dump(self.data, f, indent=2)

    # ---------- convenience ----------
    def p(self, *parts):
        return os.path.join(self.root, *parts)

    @property
    def scenes(self):
        return self.data.setdefault("scenes", [])

    def scene(self, sid):
        for s in self.scenes:
            if s["id"] == sid:
                return s
        raise KeyError("no scene %r (have %s)" % (sid, ", ".join(x["id"] for x in self.scenes)))

    def theme(self):
        t = dict(DEFAULT_THEME)
        t.update(self.data.get("theme") or {})
        return t

    # ---------- artifact tracking ----------
    def _stamps(self):
        f = self.p(".build", "stamps.json")
        if os.path.exists(f):
            with open(f) as fh:
                return json.load(fh)
        return {}

    def _write_stamps(self, s):
        os.makedirs(self.p(".build"), exist_ok=True)
        with open(self.p(".build", "stamps.json"), "w") as fh:
            json.dump(s, fh, indent=2)

    def stamp(self, key, recipe):
        """Record that artifact `key` was built from `recipe`."""
        s = self._stamps()
        s[key] = {"recipe": _h(recipe), "built": time.strftime("%Y-%m-%d %H:%M:%S")}
        self._write_stamps(s)

    def is_stale(self, key, recipe, output):
        """True if `output` is missing or was built from a different recipe."""
        if not os.path.exists(self.p(output)):
            return True
        s = self._stamps().get(key)
        return (not s) or s.get("recipe") != _h(recipe)

    # ---------- recipes: the single source of truth for "what invalidates what" ----------
    def vo_recipe(self, sc):
        return [sc.get("vo", ""), self.data["voice"], self.data["tempo"]]

    def art_recipe(self, sc):
        return [sc.get("art_prompt"), self.data.get("art_style"), self.theme()["brand"]]

    def html_recipe(self, sc):
        return [sc.get("template"), sc.get("props"), self.theme(),
                sc.get("art"), self.data["width"], self.data["height"]]

    def clip_recipe(self, sc):
        return [file_hash(self.p("scenes", sc["id"] + ".html")),
                round(float(sc.get("duration") or 0), 3),
                self.data["fps"], self.data["width"], self.data["height"]]

    def final_recipe(self):
        return [[file_hash(self.p("clips", s["id"] + ".mp4")) for s in self.scenes],
                [file_hash(self.p("vo", s["id"] + ".wav")) for s in self.scenes],
                file_hash(self.p("music.mp3")),
                self.data["transition"], self.data["music_volume"], self.data["tail"]]

    def hand_edited(self, sid):
        """A scene HTML the human changed after we materialized it. Never clobber."""
        s = self._stamps().get("html:" + sid)
        cur = file_hash(self.p("scenes", sid + ".html"))
        return bool(s and cur and s.get("output") and s["output"] != cur)

    def stamp_html(self, sid, recipe):
        s = self._stamps()
        s["html:" + sid] = {"recipe": _h(recipe),
                            "output": file_hash(self.p("scenes", sid + ".html")),
                            "built": time.strftime("%Y-%m-%d %H:%M:%S")}
        self._write_stamps(s)

    # ---------- status ----------
    def status(self):
        rows = []
        for sc in self.scenes:
            sid = sc["id"]
            rows.append({
                "id": sid,
                "template": sc.get("template"),
                "duration": sc.get("duration"),
                "vo": ("n/a" if not sc.get("vo") else
                       ("stale" if self.is_stale("vo:" + sid, self.vo_recipe(sc),
                                                 "vo/%s.wav" % sid) else "ok")),
                "art": ("n/a" if not sc.get("art_prompt") else
                        ("stale" if self.is_stale("art:" + sid, self.art_recipe(sc),
                                                  sc.get("art") or "assets/%s.png" % sid) else "ok")),
                "html": ("hand-edited" if self.hand_edited(sid) else
                         ("stale" if self.is_stale("html:" + sid, self.html_recipe(sc),
                                                   "scenes/%s.html" % sid) else "ok")),
                "clip": "stale" if self.is_stale("clip:" + sid, self.clip_recipe(sc),
                                                 "clips/%s.mp4" % sid) else "ok",
            })
        final = "stale" if self.is_stale("final", self.final_recipe(), "final.mp4") else "ok"
        return rows, final

    def keep_previous(self, name="final.mp4"):
        src = self.p(name)
        if not os.path.exists(src):
            return None
        base, ext = os.path.splitext(name)
        n = 1
        while os.path.exists(self.p("%s-v%d%s" % (base, n, ext))):
            n += 1
        dst = self.p("%s-v%d%s" % (base, n, ext))
        shutil.copy2(src, dst)
        return dst
