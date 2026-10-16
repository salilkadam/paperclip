#!/usr/bin/env python3
"""motion-explainer-studio — flat 2D animated explainer videos from a URL or a doc.

One entry point for every stage. Each stage writes plain files you can edit, and
every command rebuilds only what its inputs invalidated.

  mes.py init      <dir> --title "..." [--source URL] [--seconds 75]
  mes.py ingest    <dir> --url https://...            [--apply-theme]
  mes.py voices    <dir> [--grep jess]
  mes.py probe     <dir> --voices "Jessica,Lily" [--text "..."]
  mes.py script    <dir> --import storyboard.json | --sync | --show
  mes.py vo        <dir> [--scene s03] [--force]
  mes.py art       <dir> [--scene s03] [--force]
  mes.py music     <dir> [--force]
  mes.py build     <dir> [--scene s03] [--force]      # scene spec -> scenes/*.html
  mes.py render    <dir> [--scene s03] [--force] [--preview]
  mes.py assemble  <dir> [--force]
  mes.py dashboard <dir>
  mes.py status    <dir>
  mes.py all       <dir>                              # everything stale, in order
  mes.py edit script  <dir> s03 --vo "..." --caption "..."
  mes.py edit scene   <dir> s03 --set headline="..." --template feature_grid
  mes.py edit project <dir> --set voice=Lily --set transition.type=wipeleft
"""
import argparse
import json
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import api, art as art_lib, assemble as asm, build as builder, dashboard, ingest as ing  # noqa: E402
from lib import render as rnd, voice as vox  # noqa: E402
from lib.project import Project  # noqa: E402


# --------------------------------------------------------------------- helpers
def load(d):
    p = Project(d)
    if not p.data:
        sys.exit("%s is not a project (no project.json). Run: mes.py init %s --title \"...\"" % (d, d))
    return p


def coerce(v):
    if isinstance(v, str):
        s = v.strip()
        if s.lower() in ("true", "false"):
            return s.lower() == "true"
        if re.fullmatch(r"-?\d+", s):
            return int(s)
        if re.fullmatch(r"-?\d*\.\d+", s):
            return float(s)
        if s.startswith(("[", "{")):
            try:
                return json.loads(s)
            except Exception:
                return v
    return v


def set_path(obj, dotted, value):
    parts = dotted.split(".")
    for p in parts[:-1]:
        obj = obj.setdefault(p, {})
    obj[parts[-1]] = value


def scene_list(p, only):
    return [s for s in p.scenes if not only or s["id"] == only]


def say(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------------ init
def cmd_init(a):
    if os.path.exists(os.path.join(a.dir, "project.json")) and not a.force:
        sys.exit("project.json already exists in %s (use --force to reset)" % a.dir)
    os.makedirs(a.dir, exist_ok=True)
    p = Project.create(a.dir, a.title, source=a.source, audience=a.audience,
                       tone=a.tone, target_seconds=a.seconds, voice=a.voice)
    say("created %s" % p.path)
    say("next:  mes.py ingest %s --url <site>   (or write research.md yourself)" % a.dir)


# ---------------------------------------------------------------------- ingest
def cmd_ingest(a):
    p = load(a.dir)
    say("fetching %s ..." % a.url)
    r = ing.ingest(a.url, p.root)
    p.data["source"] = a.url
    if r.get("logo_files"):
        p.data["logo"] = r["logo_files"][0]
    if a.apply_theme and r.get("palette"):
        p.data["theme"]["brand"] = r["palette"][0]
        if len(r["palette"]) > 1:
            p.data["theme"]["accent"] = r["palette"][1]
        say("theme brand=%s accent=%s" % (p.data["theme"]["brand"], p.data["theme"]["accent"]))
    p.save()
    say("wrote research.md, research.json  (palette: %s)" % ", ".join(r.get("palette") or ["none found"]))
    say("%d headings, %d paragraphs, %d bullets, %d logo files"
        % (sum(len(v) for v in r["headings"].values()), len(r["paragraphs"]),
           len(r["bullets"]), len(r.get("logo_files") or [])))


# ---------------------------------------------------------------------- voices
def cmd_voices(a):
    load(a.dir)
    vs = api.voices()
    for v in vs:
        if not a.grep or a.grep.lower() in (v["name"] or "").lower():
            say("%-34s %s" % (v["name"], v["engine"]))
    say("-- %d voices" % len(vs))


def cmd_probe(a):
    p = load(a.dir)
    text = a.text or "Every team says they want clarity. Very few actually build for it."
    rows = vox.probe(text, [v.strip() for v in a.voices.split(",")], p.p(".build", "probe"))
    say("%-24s %8s  %s" % ("voice", "seconds", "transcript"))
    for r in rows:
        say("%-24s %8s  %s" % (r["voice"], r["seconds"], (r["heard"] or "")[:70]))
    say("\nSame words, different pace — pick for the energy you want, then:")
    say("  mes.py edit project %s --set voice=\"<name>\"" % a.dir)


# ---------------------------------------------------------------------- script
SCENE_RE = re.compile(r"^##\s+(\S+)\s*·\s*(\w+)", re.M)


def write_script_md(p):
    L = ["# Script — %s" % p.data.get("title", ""), "",
         "Edit the VO / CAPTION / SUB lines here, then run `mes.py script <dir> --sync`.",
         "Changing a VO line re-voices and re-renders only that scene.", ""]
    for s in p.scenes:
        L.append("## %s · %s · %ss" % (s["id"], s.get("template"), s.get("duration") or "?"))
        L.append("VO: %s" % (s.get("vo") or ""))
        if s.get("caption") is not None:
            L.append("CAPTION: %s" % (s.get("caption") or ""))
        if s.get("sub") is not None:
            L.append("SUB: %s" % (s.get("sub") or ""))
        L.append("")
    open(p.p("script.md"), "w").write("\n".join(L))


def cmd_script(a):
    p = load(a.dir)
    if a.import_:
        raw = json.load(open(a.import_))
        scenes = raw["scenes"] if isinstance(raw, dict) else raw
        for i, s in enumerate(scenes, 1):
            s.setdefault("id", "s%02d" % i)
            s.setdefault("template", "statement")
            s.setdefault("props", {})
        if isinstance(raw, dict):
            for k in ("theme", "voice", "music_tags", "transition", "title", "logo"):
                if k in raw:
                    if k == "theme":
                        p.data["theme"].update(raw[k])
                    else:
                        p.data[k] = raw[k]
        p.data["scenes"] = scenes
        p.save()
        write_script_md(p)
        say("imported %d scenes -> project.json + script.md" % len(scenes))
    elif a.sync:
        txt = open(p.p("script.md")).read()
        blocks = re.split(r"^##\s+", txt, flags=re.M)[1:]
        n = 0
        for b in blocks:
            head = b.splitlines()[0]
            sid = head.split("·")[0].strip()
            try:
                sc = p.scene(sid)
            except KeyError:
                say("  ! script.md mentions unknown scene %r — skipped" % sid)
                continue
            for key, field in (("VO", "vo"), ("CAPTION", "caption"), ("SUB", "sub")):
                m = re.search(r"^%s:\s*(.*)$" % key, b, re.M)
                if m:
                    val = m.group(1).strip()
                    if (sc.get(field) or "") != val:
                        sc[field] = val
                        n += 1
        p.save()
        say("synced script.md -> project.json (%d field(s) changed)" % n)
        if n:
            say("run `mes.py all %s` to re-voice and re-render what changed" % a.dir)
    else:
        for s in p.scenes:
            say("%-5s %-18s %5ss  %s" % (s["id"], s.get("template"),
                                         s.get("duration") or "?", (s.get("vo") or "")[:70]))


# -------------------------------------------------------------------------- vo
def cmd_vo(a):
    p = load(a.dir)
    lead, tail = p.data.get("lead", 0.35), p.data.get("tail", 0.45)
    for sc in scene_list(p, a.scene):
        sid = sc["id"]
        out = p.p("vo", sid + ".wav")
        if not sc.get("vo"):
            sc["duration"] = sc.get("duration") or 4.0
            continue
        if not a.force and not p.is_stale("vo:" + sid, p.vo_recipe(sc), "vo/%s.wav" % sid):
            say("  %s vo ok" % sid)
            continue
        say("  %s voicing (%d takes)" % (sid, p.data["vo_takes"]))
        try:
            _, dur, score, heard = vox.render_line(
                sc["vo"], p.data["voice"], out, p.p(".build", "takes", sid),
                takes=p.data["vo_takes"], tempo=p.data["tempo"])
        except api.NoKey as e:
            sys.exit("%s\nNarration sets every scene's length, so the pipeline cannot "
                     "continue without it." % e)
        sc["duration"] = round(lead + dur + tail, 2)
        sc["vo_score"] = score
        sc["vo_heard"] = heard
        p.stamp("vo:" + sid, p.vo_recipe(sc))
        say("    -> %.2fs (scene %.2fs) score=%d" % (dur, sc["duration"], score))
        p.save()
    p.save()
    write_script_md(p)
    total = sum(float(s.get("duration") or 0) for s in p.scenes)
    say("narration total %.1fs across %d scenes (target %ss)"
        % (total, len(p.scenes), p.data.get("target_seconds")))


# ------------------------------------------------------------------------- art
def cmd_art(a):
    p = load(a.dir)
    todo = [s for s in scene_list(p, a.scene) if s.get("art_prompt")]
    if not todo:
        say("no scenes request art (set art_prompt on a scene to generate one)")
        return
    try:
        session = api.gi_session()
    except api.NoKey as e:
        say("  ! %s — skipping art; scenes will fall back to their vector layout" % e)
        return
    for sc in todo:
        sid = sc["id"]
        rel = sc.get("art") or os.path.join("assets", sid + ".png")
        if not a.force and not p.is_stale("art:" + sid, p.art_recipe(sc), rel):
            say("  %s art ok" % sid)
            continue
        say("  %s generating art ..." % sid)
        ok, err = art_lib.generate(sc["art_prompt"], p.p(rel), p.theme(), session=session,
                                   style=p.data.get("art_style"))
        if ok:
            sc["art"] = rel
            p.stamp("art:" + sid, p.art_recipe(sc))
            say("    -> %s%s" % (rel, (" (%s)" % err) if err else ""))
        else:
            msg = str(err)
            if "insufficientCredits" in msg or "runware.ai/wallet" in msg:
                msg = ("GenImage provider (Runware) is out of credits — the operator must top "
                       "up; this scene keeps its vector layout. Mention it when delivering.")
            say("    ! failed: %s" % msg)
        p.save()
    p.save()


# ----------------------------------------------------------------------- music
def cmd_music(a):
    p = load(a.dir)
    total = sum(float(s.get("duration") or 0) for s in p.scenes) or 30
    recipe = [p.data["music_tags"]]
    if not a.force and not p.is_stale("music", recipe, "music.mp3"):
        say("music ok")
        return
    say("generating music bed (%s)" % p.data["music_tags"])
    try:
        ok = api.music(min(30, int(total)), p.data["music_tags"], p.p("music.mp3"))
    except api.NoKey as e:
        ok = False
        say("  ! %s" % e)
    if ok:
        p.stamp("music", recipe)
        say("  -> music.mp3 (the assembler loops it under the narration)")
    else:
        say("  ! no music bed — the cut will build without one (narration only)")


# ----------------------------------------------------------------------- build
def cmd_build(a):
    p = load(a.dir)
    for sc in scene_list(p, a.scene):
        sid = sc["id"]
        if p.hand_edited(sid) and not a.force:
            say("  %s html hand-edited — left alone (--force to regenerate)" % sid)
            continue
        if not a.force and not p.is_stale("html:" + sid, p.html_recipe(sc), "scenes/%s.html" % sid):
            say("  %s html ok" % sid)
            continue
        builder.materialize(p, sc)
        p.stamp_html(sid, p.html_recipe(sc))
        say("  %s -> scenes/%s.html" % (sid, sid))


# ---------------------------------------------------------------------- render
def cmd_render(a):
    p = load(a.dir)
    rnd.ensure_playwright()
    scale = 0.5 if a.preview else 1.0
    os.makedirs(p.p(".build", "poster"), exist_ok=True)
    for sc in scene_list(p, a.scene):
        sid = sc["id"]
        html_path = p.p("scenes", sid + ".html")
        if not os.path.exists(html_path):
            say("  %s no HTML yet — run `mes.py build`" % sid)
            continue
        dur = float(sc.get("duration") or 5.0)
        if not a.force and not p.is_stale("clip:" + sid, p.clip_recipe(sc), "clips/%s.mp4" % sid):
            say("  %s clip ok" % sid)
            continue
        say("  %s rendering %.2fs @%dfps%s" % (sid, dur, p.data["fps"], " (preview)" if a.preview else ""))
        rnd.render_scene(html_path, p.p("clips", sid + ".mp4"), dur,
                         fps=p.data["fps"], width=p.data["width"], height=p.data["height"],
                         scale=scale, frames_dir=p.p(".build", "frames", sid) if a.keep_frames else None)
        rnd.poster(html_path, p.p(".build", "poster", sid + ".png"),
                   t=min(1.6, dur * 0.4), width=p.data["width"], height=p.data["height"],
                   duration=dur)
        p.stamp("clip:" + sid, p.clip_recipe(sc))
    p.save()


# -------------------------------------------------------------------- assemble
def cmd_assemble(a):
    p = load(a.dir)
    clips, vos, durs = [], [], []
    for sc in p.scenes:
        c = p.p("clips", sc["id"] + ".mp4")
        if not os.path.exists(c):
            sys.exit("missing %s — run `mes.py render %s` first" % (c, a.dir))
        clips.append(c)
        v = p.p("vo", sc["id"] + ".wav")
        vos.append(v if os.path.exists(v) else None)
        durs.append(asm.probe_duration(c))
    if not a.force and not p.is_stale("final", p.final_recipe(), "final.mp4"):
        say("final.mp4 already current")
        return
    prev = p.keep_previous("final.mp4")
    if prev:
        say("kept previous cut as %s" % os.path.basename(prev))
    tr = p.data.get("transition") or {}
    music = p.p("music.mp3") if os.path.exists(p.p("music.mp3")) else None
    say("assembling %d scenes ..." % len(clips))
    out, total = asm.build(clips, vos, durs, p.p("final.mp4"), fps=p.data["fps"],
                           overlap=float(tr.get("seconds", 0.5)),
                           transition=tr.get("type", "fade"), music=music,
                           music_volume=p.data.get("music_volume", 0.5),
                           lead=p.data.get("lead", 0.35),
                           per_scene_transition={i: s.get("transition")
                                                 for i, s in enumerate(p.scenes) if s.get("transition")})
    p.stamp("final", p.final_recipe())
    dims = asm.probe_dims(p.p("final.mp4"))
    say("-> final.mp4  %.1fs  %dx%d%s"
        % (total, dims[0], dims[1],
           "   (preview resolution — re-render without --preview for delivery)"
           if dims[0] < p.data["width"] else ""))
    dashboard.write(p)


# ------------------------------------------------------------- status / review
def cmd_status(a):
    p = load(a.dir)
    rows, final = p.status()
    say("%-6s %-18s %7s  %-6s %-6s %-12s %-6s" % ("id", "template", "dur", "vo", "art", "html", "clip"))
    for r in rows:
        say("%-6s %-18s %7s  %-6s %-6s %-12s %-6s"
            % (r["id"], r["template"], r["duration"], r["vo"], r["art"], r["html"], r["clip"]))
    say("final.mp4: %s" % final)


def cmd_dashboard(a):
    p = load(a.dir)
    out = dashboard.write(p)
    say("-> %s" % out)


# ------------------------------------------------------------------------ edit
def cmd_edit(a):
    p = load(a.dir)
    if a.what == "project":
        for kv in a.set or []:
            k, v = kv.split("=", 1)
            set_path(p.data, k, coerce(v))
            say("project.%s = %r" % (k, coerce(v)))
        p.save()
        return

    sc = p.scene(a.id)
    if a.what == "script":
        for field, val in (("vo", a.vo), ("caption", a.caption), ("sub", a.sub)):
            if val is not None:
                sc[field] = val
                say("%s.%s = %r" % (a.id, field, val))
        p.save()
        write_script_md(p)
    else:  # scene
        if a.template:
            sc["template"] = a.template
            say("%s.template = %s" % (a.id, a.template))
        if a.duration:
            sc["duration"] = float(a.duration)
        if a.art:
            sc["art"] = a.art
        if a.art_prompt:
            sc["art_prompt"] = a.art_prompt
        if a.transition:
            sc["transition"] = a.transition
        for kv in a.set or []:
            k, v = kv.split("=", 1)
            set_path(sc.setdefault("props", {}), k, coerce(v))
            say("%s.props.%s = %r" % (a.id, k, coerce(v)))
        p.save()

    if p.hand_edited(a.id):
        say("note: scenes/%s.html is hand-edited, so this change will NOT appear\n"
            "      until you run: mes.py build %s --scene %s --force" % (a.id, a.dir, a.id))
    say("stale now — run `mes.py all %s`" % a.dir)


# ------------------------------------------------------------------------- all
def cmd_all(a):
    ns = argparse.Namespace
    say("[vo]");        cmd_vo(ns(dir=a.dir, scene=None, force=False))
    say("[art]");       cmd_art(ns(dir=a.dir, scene=None, force=False))
    say("[music]");     cmd_music(ns(dir=a.dir, force=False))
    say("[build]");     cmd_build(ns(dir=a.dir, scene=None, force=False))
    say("[render]");    cmd_render(ns(dir=a.dir, scene=None, force=False,
                                      preview=a.preview, keep_frames=False))
    say("[assemble]");  cmd_assemble(ns(dir=a.dir, force=False))
    say("[review]");    cmd_dashboard(ns(dir=a.dir))


# ------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(prog="mes.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, **kw):
        s = sub.add_parser(name, **kw)
        s.add_argument("dir")
        s.set_defaults(fn=fn)
        return s

    s = add("init", cmd_init)
    s.add_argument("--title", required=True)
    s.add_argument("--source"); s.add_argument("--audience")
    s.add_argument("--tone", default="confident, friendly, modern")
    s.add_argument("--seconds", type=int, default=75)
    s.add_argument("--voice", default="Jessica")
    s.add_argument("--force", action="store_true")

    s = add("ingest", cmd_ingest)
    s.add_argument("--url", required=True)
    s.add_argument("--apply-theme", action="store_true")

    s = add("voices", cmd_voices); s.add_argument("--grep")
    s = add("probe", cmd_probe)
    s.add_argument("--voices", required=True); s.add_argument("--text")

    s = add("script", cmd_script)
    s.add_argument("--import", dest="import_")
    s.add_argument("--sync", action="store_true")
    s.add_argument("--show", action="store_true")

    for name, fn in (("vo", cmd_vo), ("art", cmd_art), ("build", cmd_build)):
        s = add(name, fn)
        s.add_argument("--scene"); s.add_argument("--force", action="store_true")

    s = add("render", cmd_render)
    s.add_argument("--scene"); s.add_argument("--force", action="store_true")
    s.add_argument("--preview", action="store_true", help="half resolution, ~4x faster")
    s.add_argument("--keep-frames", action="store_true")

    s = add("music", cmd_music); s.add_argument("--force", action="store_true")
    s = add("assemble", cmd_assemble); s.add_argument("--force", action="store_true")
    add("dashboard", cmd_dashboard)
    add("status", cmd_status)
    s = add("all", cmd_all); s.add_argument("--preview", action="store_true")

    e = sub.add_parser("edit")
    e.add_argument("what", choices=["script", "scene", "project"])
    e.add_argument("dir")
    e.add_argument("id", nargs="?")
    e.add_argument("--vo"); e.add_argument("--caption"); e.add_argument("--sub")
    e.add_argument("--template"); e.add_argument("--duration"); e.add_argument("--art")
    e.add_argument("--art-prompt", dest="art_prompt"); e.add_argument("--transition")
    e.add_argument("--set", action="append")
    e.set_defaults(fn=cmd_edit)

    t = sub.add_parser("templates", help="list the scene templates")
    t.add_argument("dir", nargs="?")          # accepted and ignored, so it reads
    t.set_defaults(fn=lambda a: [print(n)     # the same as every other command
                                 for n in builder.template_names()])

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
