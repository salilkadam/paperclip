"""review.html — one page showing every stage of the cut, with the exact command
to change each piece. Open it from the project directory; all paths are relative
so it works over file:// with no server."""
import html
import os

CSS = """
:root{--bg:#0d1017;--card:#161b26;--ink:#e9edf5;--mut:#8e99ad;--brand:#4f7cff;--ok:#2dd4a7;--warn:#ffc53d;--bad:#ff7a59}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;padding:34px}
h1{font-size:26px;margin:0 0 4px} .sub{color:var(--mut);margin-bottom:26px}
.top{display:flex;gap:26px;flex-wrap:wrap;align-items:flex-start;margin-bottom:30px}
video.final{max-width:660px;border-radius:14px;background:#000}
.meta{display:grid;grid-template-columns:auto auto;gap:6px 20px;font-size:14px}
.meta b{color:var(--mut);font-weight:500}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:20px}
.card{background:var(--card);border:1px solid #23293a;border-radius:14px;overflow:hidden}
.card .thumb{width:100%;aspect-ratio:16/9;object-fit:cover;background:#0a0c12;display:block}
.card .b{padding:16px 18px}
.id{font:600 13px ui-monospace,Menlo,monospace;color:var(--brand);letter-spacing:.06em}
.tpl{color:var(--mut);font-size:13px}
.vo{margin:10px 0;font-size:15px}
.cap{font-size:13px;color:var(--warn)}
.badges{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 8px}
.bg{font:600 11px ui-monospace,monospace;padding:3px 9px;border-radius:999px;background:#222a3a;color:var(--mut)}
.bg.ok{background:rgba(45,212,167,.14);color:var(--ok)}
.bg.stale{background:rgba(255,122,89,.15);color:var(--bad)}
.bg.hand{background:rgba(255,197,61,.15);color:var(--warn)}
audio{width:100%;height:34px;margin-top:8px}
details{margin-top:10px} summary{cursor:pointer;color:var(--mut);font-size:13px}
pre{background:#0a0d14;border:1px solid #222a3a;border-radius:8px;padding:10px 12px;
  overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;color:#c9d3e6;margin:8px 0 0}
a{color:var(--brand)}
.legend{margin-top:30px;color:var(--mut);font-size:13px}
"""


def _badge(state):
    cls = {"ok": "ok", "stale": "stale", "hand-edited": "hand", "n/a": ""}.get(state, "")
    return '<span class="bg %s">%s</span>' % (cls, html.escape(state))


def write(project, out_path=None):
    rows, final_state = project.status()
    by_id = {r["id"]: r for r in rows}
    d = project.data
    total = sum(float(s.get("duration") or 0) for s in project.scenes)
    overlap = float((d.get("transition") or {}).get("seconds", 0.5))
    if len(project.scenes) > 1:
        total -= overlap * (len(project.scenes) - 1)

    cards = []
    for sc in project.scenes:
        sid = sc["id"]
        st = by_id.get(sid, {})
        thumb = os.path.join(".build", "poster", sid + ".png")
        clip = os.path.join("clips", sid + ".mp4")
        vo = os.path.join("vo", sid + ".wav")
        has_thumb = os.path.exists(project.p(thumb))
        cards.append("""
<div class="card">
  {thumb}
  <div class="b">
    <div class="id">{sid} · {dur}s</div>
    <div class="tpl">{tpl}</div>
    <div class="vo">{vo_text}</div>
    {cap}
    <div class="badges">{badges}</div>
    {audio}
    <details><summary>change this scene</summary><pre>{cmds}</pre></details>
  </div>
</div>""".format(
            thumb=('<img class="thumb" src="%s">' % thumb) if has_thumb else
                  ('<video class="thumb" src="%s" controls></video>' % clip
                   if os.path.exists(project.p(clip)) else '<div class="thumb"></div>'),
            sid=html.escape(sid),
            dur=("%.1f" % float(sc.get("duration") or 0)),
            tpl=html.escape(sc.get("template", "")),
            vo_text=html.escape(sc.get("vo") or "(no narration)"),
            cap=('<div class="cap">%s</div>' % html.escape(sc.get("caption")))
                if sc.get("caption") else "",
            badges="".join(_badge(st.get(k, "?")) for k in ("vo", "art", "html", "clip")),
            audio=('<audio controls src="%s"></audio>' % vo)
                  if os.path.exists(project.p(vo)) else "",
            cmds=html.escape(
                "# reword the narration (re-voices and re-renders just this scene)\n"
                "mes.py edit script %s --vo \"new line\"\n\n"
                "# change what is on screen\n"
                "mes.py edit scene %s --set headline=\"New headline\"\n"
                "mes.py edit scene %s --template feature_grid\n\n"
                "# hand-edit the HTML instead, then\n"
                "open scenes/%s.html   # edit freely; the build will not overwrite it\n"
                "mes.py render --scene %s\n\n"
                "mes.py assemble" % (sid, sid, sid, sid, sid)),
        ))

    final = ('<video class="final" src="final.mp4" controls></video>'
             if os.path.exists(project.p("final.mp4")) else
             '<div class="sub">No final cut yet — run <code>mes.py assemble</code>.</div>')

    doc = """<!doctype html><meta charset="utf-8"><title>{title} — review</title>
<style>{css}</style>
<h1>{title}</h1>
<div class="sub">{n} scenes · {total} · voice “{voice}” · final: {fstate}</div>
<div class="top">{final}
  <div class="meta">
    <b>source</b><span>{src}</span>
    <b>audience</b><span>{aud}</span>
    <b>tone</b><span>{tone}</span>
    <b>transition</b><span>{tr} · {ov}s</span>
    <b>music</b><span>{music}</span>
    <b>research</b><span><a href="research.md">research.md</a></span>
    <b>script</b><span><a href="script.md">script.md</a></span>
    <b>state</b><span><a href="project.json">project.json</a></span>
  </div>
</div>
<div class="grid">{cards}</div>
<div class="legend">Badges are <b>vo · art · html · clip</b>.
“stale” means the input changed and a rebuild is pending; “hand-edited” means you changed
scenes/&lt;id&gt;.html directly and the generator will leave it alone.
Run <code>mes.py all</code> to rebuild only what is stale.</div>
""".format(
        title=html.escape(d.get("title", "Untitled")), css=CSS,
        n=len(project.scenes), total="%dm %02ds" % (int(total) // 60, int(total) % 60),
        voice=html.escape(d.get("voice", "")), fstate=final_state,
        final=final, src=html.escape(str(d.get("source") or "—")),
        aud=html.escape(str(d.get("audience") or "—")),
        tone=html.escape(str(d.get("tone") or "—")),
        tr=html.escape(str((d.get("transition") or {}).get("type", "fade"))),
        ov=overlap, music=html.escape(str(d.get("music_tags") or "—")),
        cards="".join(cards))

    out_path = out_path or project.p("review.html")
    with open(out_path, "w") as f:
        f.write(doc)
    return out_path
