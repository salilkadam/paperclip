"""Deterministic HTML/SVG -> MP4 renderer.

The whole point: we do NOT screen-record. Recording a page in real time makes the
output depend on machine speed, and a busy box silently drops frames. Instead we
pause every animation on the page and *seek* the Web Animations timeline to
exactly frame/fps for each frame, screenshot, and pipe the PNG straight into
ffmpeg. Same input, same bytes out, on any machine, at any speed.

Two constraints follow from that, and both are load-bearing:

  1. Motion must be expressed as CSS animations / transitions / WAAPI, because
     only those show up in `document.getAnimations()`. SVG SMIL (<animate>,
     <animateTransform>) is NOT seekable this way and will render frozen. Use
     CSS transforms on SVG elements instead.
  2. Anything driven by JS must expose `window.MES.seek(tSeconds)` and be pure
     with respect to t — no accumulating state, no reading wall-clock time.
     engine.js implements this for counters, typewriters and progress bars.
"""
import os
import shutil
import subprocess
import sys

SEEK_JS = """
(t) => {
  const ms = t * 1000;
  for (const a of document.getAnimations()) {
    try {
      a.pause();
      const d = (a.effect && a.effect.getComputedTiming) ? a.effect.getComputedTiming() : null;
      let end = d ? (d.endTime || 0) : 0;
      if (!isFinite(end) || end <= 0) end = ms;         // infinite loops: seek freely
      a.currentTime = Math.min(ms, end);
    } catch (e) {}
  }
  if (window.MES && typeof window.MES.seek === 'function') window.MES.seek(t);
  return document.getAnimations().length;
}
"""

READY_JS = """
async () => {
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
  const imgs = Array.from(document.images);
  await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => {
    i.addEventListener('load', r); i.addEventListener('error', r);
  })));
  for (const a of document.getAnimations()) { try { a.pause(); } catch (e) {} }
  return {anims: document.getAnimations().length, imgs: imgs.length};
}
"""


def _launch(pw):
    return pw.chromium.launch(args=[
        "--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars",
        "--disable-lcd-text", "--font-render-hinting=none",
        "--enable-unsafe-swiftshader",
    ])


def render_scene(html_path, out_mp4, duration, fps=30, width=1920, height=1080,
                 scale=1.0, crf=17, quiet=False, frames_dir=None):
    """Render one scene HTML to a silent, constant-frame-rate MP4."""
    from playwright.sync_api import sync_playwright

    # The viewport is always the stage size in CSS pixels; `scale` is the device
    # pixel ratio, so a 0.5 preview renders the SAME layout at half the pixels.
    # (Scaling the viewport instead would leave the fixed-size stage sitting in
    # the corner of an oversized page — an easy and very confusing mistake.)
    n = max(1, int(round(duration * fps)))
    vw, vh = width, height
    if frames_dir:
        os.makedirs(frames_dir, exist_ok=True)

    ff = subprocess.Popen([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "image2pipe", "-vcodec", "png", "-framerate", str(fps), "-i", "-",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",   # odd dims at scale!=1 break h264
        "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-r", str(fps), "-vsync", "cfr",
        "-movflags", "+faststart", out_mp4,
    ], stdin=subprocess.PIPE)

    with sync_playwright() as pw:
        browser = _launch(pw)
        page = browser.new_page(viewport={"width": vw, "height": vh}, device_scale_factor=scale)
        page.goto("file://" + os.path.abspath(html_path), wait_until="load")
        page.evaluate("document.documentElement.style.setProperty('--scene-duration','%gs')" % duration)
        page.evaluate(READY_JS)
        for i in range(n):
            t = i / float(fps)
            page.evaluate(SEEK_JS, t)
            png = page.screenshot(type="png", animations="disabled")
            if frames_dir and i % max(1, n // 6) == 0:
                with open(os.path.join(frames_dir, "f%05d.png" % i), "wb") as fh:
                    fh.write(png)
            try:
                ff.stdin.write(png)
            except BrokenPipeError:
                break
            if not quiet and n > 60 and i % (n // 10 or 1) == 0:
                print("    %s %3d%%" % (os.path.basename(out_mp4), 100 * i // n),
                      file=sys.stderr, flush=True)
        browser.close()

    ff.stdin.close()
    rc = ff.wait()
    if rc != 0 or not os.path.exists(out_mp4):
        raise RuntimeError("ffmpeg failed on %s (rc=%s)" % (html_path, rc))
    return out_mp4


def poster(html_path, out_png, t=1.2, width=1920, height=1080, scale=0.5, duration=6.0):
    """Single frame, for dashboard thumbnails and quick visual checks."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = _launch(pw)
        page = browser.new_page(viewport={"width": width, "height": height},
                                device_scale_factor=scale)
        page.goto("file://" + os.path.abspath(html_path), wait_until="load")
        page.evaluate("document.documentElement.style.setProperty('--scene-duration','%gs')" % duration)
        page.evaluate(READY_JS)
        page.evaluate(SEEK_JS, t)
        page.screenshot(path=out_png, type="png", animations="disabled")
        browser.close()
    return out_png


def ensure_playwright():
    """Actionable failure instead of a stack trace three stages in."""
    try:
        import playwright  # noqa: F401
    except ImportError:
        sys.exit("Playwright is missing. Install it once:\n"
                 "  pip install playwright --break-system-packages\n"
                 "  python3 -m playwright install chromium\n"
                 "On a bare Linux box also: python3 -m playwright install-deps chromium")
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found on PATH.")
