"""Pull a website apart into the raw material for a script: copy, palette, logo.

Stdlib only. The palette extraction is the part worth knowing about — a brand's
real colours live in its stylesheets, not its screenshots, so we count hex and
rgb() literals across the page and its first few stylesheets and drop anything
that is effectively black, white or grey. That gives a usable brand/accent pair
for most marketing sites without anyone eyedropping anything.
"""
import colorsys
import json
import os
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = {"User-Agent": "Mozilla/5.0 (compatible; motion-explainer-studio/1.0)"}
SKIP_TAGS = {"script", "style", "noscript", "svg", "head"}


def fetch(url, limit=1_500_000, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(limit).decode(r.headers.get_content_charset() or "utf-8", "replace")


def fetch_bytes(url, limit=8_000_000, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(limit)


class Extract(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.text = []          # (tag, text)
        self.meta = {}
        self.links = []
        self.imgs = []
        self.css = []
        self.styles = []
        self._buf = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.stack.append(tag)
        if tag == "meta":
            k = (a.get("property") or a.get("name") or "").lower()
            if k:
                self.meta[k] = a.get("content", "")
        elif tag == "link":
            rel = (a.get("rel") or "").lower()
            href = a.get("href", "")
            if "stylesheet" in rel:
                self.css.append(href)
            if "icon" in rel:
                self.links.append(("icon", href))
        elif tag == "img":
            self.imgs.append({"src": a.get("src") or a.get("data-src") or "",
                              "alt": a.get("alt", ""), "cls": a.get("class", "")})
        if a.get("style"):
            self.styles.append(a["style"])

    def handle_endtag(self, tag):
        txt = " ".join("".join(self._buf).split())
        if txt and tag in ("h1", "h2", "h3", "h4", "p", "li", "a", "button", "span", "div", "title"):
            self.text.append((tag, txt))
        self._buf = []
        if tag in self.stack:
            while self.stack and self.stack.pop() != tag:
                pass

    def handle_data(self, data):
        if not (set(self.stack) & SKIP_TAGS):
            self._buf.append(data)


HEX = re.compile(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b")
RGB = re.compile(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)")


def _norm_hex(h):
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return "#" + h.upper()


def _interesting(hexcolor):
    r, g, b = (int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return s > 0.25 and 0.15 < l < 0.82


def palette(*texts):
    counts = {}
    for t in texts:
        for m in HEX.finditer(t):
            c = _norm_hex(m.group(1))
            counts[c] = counts.get(c, 0) + 1
        for m in RGB.finditer(t):
            c = "#%02X%02X%02X" % tuple(min(255, int(x)) for x in m.groups())
            counts[c] = counts.get(c, 0) + 1
    ranked = sorted((c for c in counts if _interesting(c)), key=lambda c: -counts[c])
    # a second colour that is actually different in hue, not a tint of the first
    out = ranked[:1]
    for c in ranked[1:]:
        if not out:
            break
        h1 = colorsys.rgb_to_hls(*(int(out[0][i:i + 2], 16) / 255 for i in (1, 3, 5)))[0]
        h2 = colorsys.rgb_to_hls(*(int(c[i:i + 2], 16) / 255 for i in (1, 3, 5)))[0]
        if min(abs(h1 - h2), 1 - abs(h1 - h2)) > 0.08:
            out.append(c)
            break
    return out, counts


def guess_logo(base, parsed):
    cands = []
    for img in parsed.imgs:
        s = (img["src"] + " " + img["alt"] + " " + img["cls"]).lower()
        if "logo" in s or "brand" in s:
            cands.append(img["src"])
    for kind, href in parsed.links:
        if kind == "icon":
            cands.append(href)
    if parsed.meta.get("og:image"):
        cands.append(parsed.meta["og:image"])
    seen, out = set(), []
    for c in cands:
        if not c or c.startswith("data:"):
            continue
        u = urllib.parse.urljoin(base, c)
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def ingest(url, out_dir, max_css=3):
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.join(out_dir, "assets"), exist_ok=True)
    html = fetch(url)
    p = Extract()
    p.feed(html)

    css_text = []
    for href in p.css[:max_css]:
        try:
            css_text.append(fetch(urllib.parse.urljoin(url, href), limit=600_000))
        except Exception:
            pass

    colors, counts = palette(html, *css_text, *p.styles)

    def take(tag, n, minlen=0):
        return [t for g, t in p.text if g == tag and len(t) >= minlen][:n]

    research = {
        "url": url,
        "title": (p.meta.get("og:title") or "").strip() or (take("title", 1) or [""])[0],
        "description": p.meta.get("og:description") or p.meta.get("description", ""),
        "headings": {"h1": take("h1", 6), "h2": take("h2", 14), "h3": take("h3", 18)},
        "paragraphs": take("p", 25, minlen=60),
        "bullets": take("li", 30, minlen=12),
        "ctas": [t for g, t in p.text if g in ("a", "button") and 3 < len(t) < 30][:15],
        "palette": colors,
        "palette_counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])[:12]),
        "logo_candidates": guess_logo(url, p),
        "og_image": urllib.parse.urljoin(url, p.meta["og:image"]) if p.meta.get("og:image") else None,
    }

    saved = []
    for i, u in enumerate(research["logo_candidates"][:3]):
        try:
            data = fetch_bytes(u, limit=3_000_000)
            ext = os.path.splitext(urllib.parse.urlparse(u).path)[1][:5] or ".png"
            path = os.path.join(out_dir, "assets", "logo%d%s" % (i, ext))
            with open(path, "wb") as f:
                f.write(data)
            saved.append(os.path.relpath(path, out_dir))
        except Exception:
            pass
    research["logo_files"] = saved

    with open(os.path.join(out_dir, "research.json"), "w") as f:
        json.dump(research, f, indent=2)
    with open(os.path.join(out_dir, "research.md"), "w") as f:
        f.write(to_markdown(research))
    return research


def to_markdown(r):
    L = ["# Research — %s" % (r.get("title") or r.get("url")), ""]
    L += ["Source: %s" % r.get("url", "n/a"), ""]
    if r.get("description"):
        L += ["> %s" % r["description"], ""]
    if r.get("palette"):
        L += ["**Palette found:** " + ", ".join(r["palette"]), ""]
    if r.get("logo_files"):
        L += ["**Logo candidates:** " + ", ".join(r["logo_files"]), ""]
    for k, label in (("h1", "H1"), ("h2", "H2"), ("h3", "H3")):
        vals = r.get("headings", {}).get(k) or []
        if vals:
            L += ["## %s" % label] + ["- %s" % v for v in vals] + [""]
    if r.get("paragraphs"):
        L += ["## Body copy"] + ["- %s" % v for v in r["paragraphs"]] + [""]
    if r.get("bullets"):
        L += ["## Bullets"] + ["- %s" % v for v in r["bullets"]] + [""]
    if r.get("ctas"):
        L += ["## Calls to action", ", ".join(dict.fromkeys(r["ctas"])), ""]
    L += ["---", "",
          "Edit this file freely — the script stage reads it, not the raw JSON.",
          "Anything you delete here will not end up in the video; anything you add will be treated as fact."]
    return "\n".join(L)
