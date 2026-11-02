#!/bin/sh
# smoke.sh BASE_URL SITEMAP_FILE — the Reliora website smoke test.
#
# Owned by the deployer (salilkadam/paperclip), never by a site commit: a commit
# can change which pages exist, but not what this test demands. It prints one
# line per check and exits 0 only if every check passed.
#
# Every request is bounded (10 s, 60 MB) and retried once, so a commit cannot
# hang it with a slow or endless response.
set -u
BASE="${1:?base URL}"; SITEMAP="${2:?sitemap file}"
fails=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# fetch PATH -> writes $TMP/body and $TMP/head; prints the status code
fetch() {
  code=000
  for _ in 1 2; do
    code="$(curl -sS -o "$TMP/body" -D "$TMP/head" -w '%{http_code}' \
      --max-time 10 --max-filesize 60000000 --proto =http \
      "$BASE$1" 2>/dev/null)" || code=000
    [ "$code" != 000 ] && break
  done
  echo "$code"
}
ok()   { echo "ok   $*"; }
bad()  { echo "FAIL $*"; fails=$((fails + 1)); }
header() { grep -qi "^$1:" "$TMP/head"; }
headers_ok() { # the security headers deploy/security-headers.conf must add
  for h in X-Content-Type-Options X-Frame-Options Referrer-Policy; do
    header "$h" || { bad "$1: missing header $h"; return; }
  done
}
title_starts() { grep -o '<title>[^<]*' "$TMP/body" | head -1 | sed 's/<title>//' | grep -qF -- "$1"; }

# 1. health
[ "$(fetch /healthz)" = 200 ] && ok /healthz || bad "/healthz not 200"

# 2. fixed pages with their exact title prefixes. "Srenix" alone is not enough:
#    public/index.html, a meta-refresh fallback, has that title.
while IFS='|' read -r path title; do
  [ -n "$path" ] || continue
  c="$(fetch "$path")"
  if [ "$c" != 200 ]; then bad "$path -> $c"; continue; fi
  title_starts "$title" || { bad "$path: title is not '$title...'"; continue; }
  headers_ok "$path"
  ok "$path"
done <<'EOF'
/|Srenix by Reliora — AI SRE that fixes Kubernetes incidents
/_site-features.html|Features — Srenix AI SRE for Kubernetes
/_site-pricing.html|Pricing — Srenix AI SRE for Kubernetes
/_site-security.html|Security — in-cluster AI SRE
/_site-design-partners.html|Design Partner programme
/_site-contact.html|Contact — talk to the Srenix team
EOF

# 3. every page in the release's sitemap, except what the blog service serves
#    through Kong (/_site-blog*, /blog-media/, /sitemap-blog.xml).
if [ -f "$SITEMAP" ] && [ ! -L "$SITEMAP" ]; then
  urls="$(head -c 1000000 "$SITEMAP" | grep -o '<loc>https://reliora\.ai/[^<]*' | sed 's#<loc>https://reliora\.ai##')"
  n="$(printf '%s\n' "$urls" | grep -c .)"
  [ "$n" -ge 10 ] && ok "sitemap has $n URLs" || bad "sitemap has $n URLs (fewer than 10)"
  for u in $urls; do
    case "$u" in
      /_site-blog*|/blog-media/*|/sitemap-blog.xml) echo "skip $u (blog service)"; continue ;;
    esac
    case "$u" in *[!A-Za-z0-9/_.-]*) bad "sitemap URL with unexpected characters"; continue ;; esac
    c="$(fetch "$u")"; [ "$c" = 200 ] && ok "$u" || bad "$u -> $c"
  done
else
  bad "no sitemap at $SITEMAP"
fi

# 4. the 404 page, with its headers
c="$(fetch "/no-such-page-$$-$(date +%s)")"
if [ "$c" = 404 ] && title_starts "Page not found | Reliora"; then headers_ok /404; ok "404 page"
else bad "unknown path -> $c, or not the site's 404 page"; fi

# 5. one asset
c="$(fetch /assets/brand/reliora-logo.svg)"; [ "$c" = 200 ] && ok "logo" || bad "logo -> $c"

# 6. three redirects from the map in deploy/nginx.conf (old addresses)
while IFS='|' read -r from to; do
  [ -n "$from" ] || continue
  c="$(fetch "$from")"
  loc="$(grep -i '^location:' "$TMP/head" | head -1 | tr -d '\r' | sed 's/^[Ll]ocation: *//')"
  case "$c:$loc" in
    301:*"$to") ok "redirect $from" ;;
    *) bad "redirect $from -> $c $loc (want 301 to $to)" ;;
  esac
done <<'EOF'
/about/|/_site-about.html
/legal/privacy|/_site-privacy.html
/docs/integrations|/_site-integrations.html
EOF

[ "$fails" -eq 0 ] && { echo "SMOKE OK"; exit 0; }
echo "SMOKE FAILED ($fails)"; exit 1
