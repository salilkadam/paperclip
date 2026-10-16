"""Thin client for the self-hosted baisoln stack (TTS, STT, LLM, GenImage, music).

Everything goes to https://mcp.baisoln.com with header X-API-Key. The key is
resolved at run time and never written to disk. See references/cluster-api.md
for the endpoint contracts and the failure modes each helper works around.
"""
import base64
import json
import os
import re
import subprocess
import sys
import time

BASE = os.environ.get("MCP_BASE", "https://mcp.baisoln.com")
SPEECH = BASE + "/gpu-ai/v1/audio/speech"
STT = BASE + "/gpu-ai/v1/audio/transcriptions"
CHAT = BASE + "/gpu-ai/v1/chat/completions"
VOICES = BASE + "/gpu-ai/v1/audio/voices"
MUSIC = BASE + "/gpu-ai/v1/audio/music"
GENIMAGE = BASE + "/genimage/mcp"

_KEY = None


def key():
    """MCP_API_KEY is platform-provided (Vault -> External Secrets -> env)."""
    global _KEY
    if _KEY:
        return _KEY
    k = os.environ.get("MCP_API_KEY", "").strip()
    if not k:
        sh = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "get_key.sh")
        k = subprocess.run(["bash", sh], capture_output=True, text=True).stdout.strip()
    if not k:
        raise NoKey("No API key: MCP_API_KEY is not set. It is platform-provided; "
                    "report the missing env var to the operator (references/cluster-api.md §1).")
    _KEY = k
    return k


class NoKey(RuntimeError):
    """Raised instead of exiting, so optional stages can degrade rather than
    take the whole run down."""


def _curl(args, timeout=180, binary=False):
    r = subprocess.run(["curl", "-s", "-m", str(timeout)] + args,
                       capture_output=True, text=not binary)
    return r.stdout


def check():
    """Cheap auth probe. Returns the voice list or raises."""
    out = _curl(["-X", "GET", VOICES, "-H", "X-API-Key: " + key()], timeout=60)
    try:
        return json.loads(out)
    except Exception:
        raise RuntimeError("voice registry did not return JSON — key or gateway problem: "
                           + str(out)[:200])


def voices():
    v = check()
    # Gateway shape: {"object": "list", "data": {"voices": [...]}}; older
    # shapes put the list directly under "voices" or "data".
    while isinstance(v, dict):
        v = v.get("voices") if "voices" in v else v.get("data", [])
    out = []
    for item in v:
        if isinstance(item, str):
            out.append({"name": item, "engine": "?"})
        else:
            out.append({"name": item.get("name") or item.get("voice") or item.get("id"),
                        "engine": item.get("engine", "?")})
    return out


# ---------------------------------------------------------------- speech / stt
def speak(text, voice, out_path, timeout=150):
    body = json.dumps({"voice": voice, "input": text, "response_format": "wav"})
    _curl(["-o", out_path, "-X", "POST", SPEECH,
           "-H", "X-API-Key: " + key(), "-H", "Content-Type: application/json",
           "-d", body], timeout=timeout)
    return os.path.exists(out_path) and os.path.getsize(out_path) > 2000


def transcribe(wav, timeout=120):
    out = _curl(["-X", "POST", STT, "-H", "X-API-Key: " + key(),
                 "-F", "model=faster-whisper", "-F", "file=@" + wav], timeout=timeout)
    try:
        return json.loads(out).get("text", "").strip()
    except Exception:
        return ""


# ---------------------------------------------------------------------- llm
def chat(prompt, system=None, model="qwen3.5-27b-fp8", max_tokens=2000, temperature=0.7,
         retries=3):
    """vLLM sleeps when idle; a cold wake can exceed Cloudflare's ~100s cap and
    return 524. The disconnect does not abort the load, so retry with backoff."""
    msgs = ([{"role": "system", "content": system}] if system else []) + \
           [{"role": "user", "content": prompt}]
    body = json.dumps({"model": model, "messages": msgs,
                       "max_tokens": max_tokens, "temperature": temperature})
    for attempt in range(retries):
        out = _curl(["-X", "POST", CHAT, "-H", "X-API-Key: " + key(),
                     "-H", "Content-Type: application/json", "-d", body], timeout=180)
        try:
            return json.loads(out)["choices"][0]["message"]["content"]
        except Exception:
            if attempt == retries - 1:
                raise RuntimeError("chat failed: " + str(out)[:300])
            time.sleep(20 * (attempt + 1))


def warm():
    try:
        chat("say READY", max_tokens=8, retries=1)
    except Exception:
        pass


# --------------------------------------------------------------------- music
def music(seconds, tags, out_path):
    """Body field is `tags` — a `prompt` body returns 422. Caps at ~30s; the
    assembler loops it."""
    body = json.dumps({"tags": tags, "duration": int(seconds)})
    _curl(["-o", out_path, "-X", "POST", MUSIC, "-H", "X-API-Key: " + key(),
           "-H", "Content-Type: application/json", "-d", body], timeout=300)
    return os.path.exists(out_path) and os.path.getsize(out_path) > 5000


# ------------------------------------------------------------------ genimage
def _gi_session():
    body = json.dumps({"jsonrpc": "2.0", "method": "initialize", "id": 1, "params": {
        "protocolVersion": "2024-11-05", "capabilities": {},
        "clientInfo": {"name": "motion-explainer-studio", "version": "1.0"}}})
    out = _curl(["-D-", "-X", "POST", GENIMAGE,
                 "-H", "X-API-Key: " + key(), "-H", "Content-Type: application/json",
                 "-H", "Accept: application/json, text/event-stream", "-d", body], timeout=90)
    for line in out.splitlines():
        if line.lower().startswith("mcp-session-id:"):
            return line.split(":", 1)[1].strip()
    return None


def _gi_extract(raw):
    found = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("image_data", "imageBase64", "b64_json") and isinstance(v, str) and len(v) > 1000:
                    found.append(v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, str) and o.strip().startswith("{") and "image" in o:
            try:
                walk(json.loads(o))
            except Exception:
                pass

    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            try:
                walk(json.loads(line[5:].strip()))
            except Exception:
                continue
    return found[0] if found else None


def image(prompt, out_path, width=1024, height=1024, steps=28, cfg=5.0, session=None):
    """Default model only — FLUX-dev times out. Dimensions must be multiples of 16."""
    sid = session or _gi_session()
    body = json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 2, "params": {
        "name": "gi_generate_image",
        "arguments": {"tenant_id": "base", "prompt": prompt, "width": width,
                      "height": height, "steps": steps, "cfg_scale": cfg}}})
    out = _curl(["-X", "POST", GENIMAGE, "-H", "X-API-Key: " + key(),
                 "-H", "Content-Type: application/json",
                 "-H", "Accept: application/json, text/event-stream",
                 "-H", "Mcp-Session-Id: " + str(sid), "-d", body], timeout=300)
    b64 = _gi_extract(out)
    if not b64:
        return False, str(out)[-200:]
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(re.sub(r"^data:image/\w+;base64,", "", b64)))
    return True, None


def gi_session():
    return _gi_session()
