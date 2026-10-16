"""A ~60-line mustache subset, so the skill has zero template dependencies.

Supported:
  {{path.to.value}}    HTML-escaped
  {{{path.to.value}}}  raw (use for HTML/SVG/CSS you generated yourself)
  {{#list}}...{{/list}} loop; inside, {{.}} is the item, {{@index}} is 0-based,
                        {{@n}} is 1-based; dicts expose their own keys
  {{#flag}}...{{/flag}} render if truthy
  {{^flag}}...{{/flag}} render if falsy
"""
import html
import re

SECTION = re.compile(r"\{\{([#^])([\w.]+)\}\}(.*?)\{\{/\2\}\}", re.S)
VAR = re.compile(r"\{\{(\{)?([@\w.]+|\.)\}?\}\}")


def _lookup(ctx, path):
    if path == ".":
        return ctx if not isinstance(ctx, dict) else ctx.get(".", "")
    cur = ctx
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = getattr(cur, part, None)
        if cur is None:
            return None
    return cur


def render(text, ctx):
    def section(m):
        kind, name, body = m.group(1), m.group(2), m.group(3)
        val = _lookup(ctx, name)
        if kind == "^":
            return render(body, ctx) if not val else ""
        if not val:
            return ""
        if isinstance(val, list):
            out = []
            for i, item in enumerate(val):
                sub = dict(ctx)
                if isinstance(item, dict):
                    sub.update(item)
                else:
                    sub["."] = item
                sub["@index"] = i
                sub["@n"] = i + 1
                out.append(render(body, sub))
            return "".join(out)
        if isinstance(val, dict):
            sub = dict(ctx)
            sub.update(val)
            return render(body, sub)
        return render(body, ctx)

    prev = None
    while prev != text:
        prev = text
        text = SECTION.sub(section, text)

    def var(m):
        raw, name = m.group(1), m.group(2)
        val = _lookup(ctx, name)
        if val is None:
            return ""
        s = str(val)
        return s if raw else html.escape(s, quote=False)

    return VAR.sub(var, text)
