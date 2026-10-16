#!/usr/bin/env python3
"""Generate filler-free per-scene voiceover via best-of-N + faster-whisper QA.

Reads scene_lines.json (a JSON array of VO strings, one per scene). For each
scene it generates up to K takes with the chosen voice, transcribes each with
faster-whisper, scores by inserted-word count vs. the script, keeps the cleanest,
and writes the polished take to vo/scene<i>.wav.

Env:
  VOICE   voice id from the registry (default "Don LaFontaine")
  K       takes per scene (default 8)
  LINES   path to scene lines json (default scene_lines.json)
  OUTDIR  output dir (default vo)
Requires MCP_API_KEY (platform-provided). Run from your workspace dir.
"""
import os, json, subprocess, sys, re, os, difflib

VOICE = os.environ.get("VOICE", "Don LaFontaine")
K = int(os.environ.get("K", "8"))
LINES = os.environ.get("LINES", "scene_lines.json")
OUTDIR = os.environ.get("OUTDIR", "vo")
SPEECH = "https://mcp.baisoln.com/gpu-ai/v1/audio/speech"
STT = "https://mcp.baisoln.com/gpu-ai/v1/audio/transcriptions"
POLISH = (f"atempo={os.environ.get('TEMPO','1.0')},"
          "acompressor=threshold=-20dB:ratio=3:attack=8:release=150,"
          "treble=g=2:f=4500,loudnorm=I=-14:TP=-1.5:dual_mono=true")

# MCP_API_KEY is platform-provided; get_key.sh reports clearly if it is missing.
key = os.environ.get("MCP_API_KEY", "").strip() or subprocess.run(["bash", os.path.join(os.path.dirname(os.path.abspath(__file__)), "get_key.sh")],
    capture_output=True, text=True).stdout.strip()
os.makedirs(OUTDIR, exist_ok=True)
lines = json.load(open(LINES))

# Words that are clearly TTS artifacts when inserted (not in the script).
FILLERS = {"hey","eh","ehh","uh","uhh","um","umm","ah","ahh","oh","ohh","benny",
           "eddie","well","hmm","mm","er","erm","yeah","okay","now","so","and",
           "that","that's","you","any","app","yay","a","an","the"}
NUMS = {"3":"three","50":"fifty","2":"two"}

def norm(t):
    t = t.lower().replace("a.m.","am").replace("aisre","ai sre")
    return [NUMS.get(w, w) for w in re.findall(r"[a-z']+|[0-9]+", t)]

def gen(text, out):
    subprocess.run(["curl","-s","-m","120","-o",out,"-X","POST",SPEECH,
        "-H",f"X-API-Key: {key}","-H","Content-Type: application/json",
        "-d",json.dumps({"voice":VOICE,"input":text,"response_format":"wav"})],
        capture_output=True)

def transcribe(wav):
    r = subprocess.run(["curl","-s","-m","90","-X","POST",STT,"-H",f"X-API-Key: {key}",
        "-F","model=faster-whisper","-F",f"file=@{wav}"], capture_output=True, text=True)
    try: return json.loads(r.stdout).get("text","").strip()
    except Exception: return ""

def score(orig, heard):
    ow, hw = norm(orig), norm(heard)
    ofirst = ow[0] if ow else ""
    inserted, deleted = [], []
    for tag,i1,i2,j1,j2 in difflib.SequenceMatcher(None, ow, hw).get_opcodes():
        if tag in ("insert","replace"):
            inserted += hw[j1:j2]
        if tag in ("delete","replace"):
            deleted += ow[i1:i2]
    extra = len(inserted)
    filler = sum(1 for w in inserted if w in FILLERS)
    lead = 3 if (hw and hw[0] != ofirst and (hw[0] in FILLERS or len(hw[0]) <= 3)) else 0
    # Penalize DELETIONS (skipped script words) hard. Without this the scorer
    # rewards short takes that silently DROP content — e.g. a CTA take that omits
    # the whole URL scores "clean" and wins. Dropped script words are worse than
    # a stray filler: a viewer noticing a missing call-to-action is the failure.
    dropped = len(deleted) * 4
    return extra*3 + filler*4 + lead + dropped

for i, orig in enumerate(lines, 1):
    best = None
    for k in range(K):
        wav = f"{OUTDIR}/try{i}_{k}.wav"
        gen(orig, wav)
        heard = transcribe(wav)
        sc = score(orig, heard)
        print(f"scene{i} take{k}: score={sc} | {heard[:80]}", flush=True)
        if best is None or sc < best[0]:
            best = (sc, wav, heard)
        if best[0] == 0:
            break
    sc, wav, heard = best
    subprocess.run(["ffmpeg","-y","-i",wav,"-af",POLISH,"-ar","48000",
        f"{OUTDIR}/scene{i}.wav"], capture_output=True)
    print(f"==> scene{i} CHOSEN score={sc}: {heard[:80]}\n", flush=True)
print(f"DONE -> {OUTDIR}/scene*.wav  (voice={VOICE})")
