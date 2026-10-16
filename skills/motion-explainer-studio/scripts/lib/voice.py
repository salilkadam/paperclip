"""Voiceover: best-of-N with speech-to-text scoring.

Cloned voices are stochastic. They inject "uh"/"so" at phrase boundaries and
occasionally swallow a clause. Generating K takes, transcribing each and keeping
the one closest to the script is the difference between broadcast-clean and
embarrassing — and it costs seconds, not minutes.

The scorer weights DROPPED script words 4x, deliberately. A take that silently
omits half the call-to-action is short and fluent and would otherwise win.
"""
import difflib
import json
import os
import re
import subprocess

from . import api

FILLERS = {"uh", "uhh", "um", "umm", "ah", "ahh", "oh", "er", "erm", "hmm", "mm",
           "well", "yeah", "okay", "so", "now", "and", "the", "a", "an", "you"}


def norm(t):
    return re.findall(r"[a-z']+|[0-9]+", t.lower())


def score(script, heard):
    ow, hw = norm(script), norm(heard)
    if not hw:
        return 999
    inserted, deleted = [], []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ow, hw).get_opcodes():
        if tag in ("insert", "replace"):
            inserted += hw[j1:j2]
        if tag in ("delete", "replace"):
            deleted += ow[i1:i2]
    filler = sum(1 for w in inserted if w in FILLERS)
    lead = 3 if (hw[0] != (ow[0] if ow else "") and (hw[0] in FILLERS or len(hw[0]) <= 3)) else 0
    return len(inserted) * 3 + filler * 4 + lead + len(deleted) * 4


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "json", path], capture_output=True, text=True).stdout
    try:
        return float(json.loads(out)["format"]["duration"])
    except Exception:
        return 0.0


def polish(src, dst, tempo=1.0):
    chain = ("atempo=%g,acompressor=threshold=-20dB:ratio=3:attack=8:release=150,"
             "treble=g=2:f=4500,loudnorm=I=-14:TP=-1.5:dual_mono=true" % tempo)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
                    "-af", chain, "-ar", "48000", "-ac", "1", dst], capture_output=True)
    return dst


def render_line(text, voice, out_wav, tmp_dir, takes=5, tempo=1.0, verbose=True):
    """Returns (path, duration_seconds, score, transcript)."""
    os.makedirs(tmp_dir, exist_ok=True)
    best = None
    for k in range(max(1, takes)):
        tmp = os.path.join(tmp_dir, "take%d.wav" % k)
        if not api.speak(text, voice, tmp):
            continue
        heard = api.transcribe(tmp)
        s = score(text, heard)
        if verbose:
            print("      take %d  score=%-4d %s" % (k, s, heard[:70]), flush=True)
        if best is None or s < best[0]:
            best = (s, tmp, heard)
        if s == 0:
            break
    if best is None:
        raise RuntimeError("TTS produced nothing for: %.60s" % text)
    s, tmp, heard = best
    polish(tmp, out_wav, tempo)
    return out_wav, duration(out_wav), s, heard


def probe(text, candidates, out_dir):
    """Speak one line through several voices; duration is the useful signal."""
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    for v in candidates:
        p = os.path.join(out_dir, re.sub(r"\W+", "_", v) + ".wav")
        if api.speak(text, v, p):
            rows.append({"voice": v, "seconds": round(duration(p), 2),
                         "heard": api.transcribe(p), "file": p})
        else:
            rows.append({"voice": v, "seconds": None, "heard": "(failed)", "file": None})
    return rows
