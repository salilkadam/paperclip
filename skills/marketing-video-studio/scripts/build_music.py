#!/usr/bin/env python3
"""Build one instrumental music bed: build_music.py <seconds> "<tags>" -> $MUSIC_OUT.

Tries the gpu-ai REST music endpoint first (needs MCP_API_KEY), then falls back to
ComfyUI ACE-Step via in-cluster service DNS (only resolvable inside the cluster).
"""
import json, sys, subprocess, time, os

# ComfyUI fallback endpoint. Override with COMFY_URL.
COMFY = os.environ.get("COMFY_URL", "http://comfyui.comfyui.svc.cluster.local:8188")
CKPT = "ace_step_v1_3.5b.safetensors"
SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0
TAGS = (sys.argv[2] if len(sys.argv) > 2 else
        "cinematic dramatic tension, dark hybrid orchestral electronic, driving percussion, "
        "rising epic build, pulsing synth bass, corporate tech trailer, intense, no vocals, instrumental")
OUT = os.environ.get("MUSIC_OUT", "ace_music.mp3")

# --- gpu-ai REST music endpoint (tried first) -----------------------------------
# POST /gpu-ai/v1/audio/music. GOTCHA: the body field is "tags" (NOT "prompt" —
# a "prompt" body returns HTTP 422 missing-field). Returns audio/mpeg directly.
# It caps output at ~30s regardless of `duration`; assembly loops the bed to cover
# the full video, so a 30s bed is fine.
def try_rest():
    key = os.environ.get("MCP_API_KEY","").strip() or subprocess.run(
        ["bash", os.path.join(os.path.dirname(os.path.abspath(__file__)), "get_key.sh")],
        capture_output=True, text=True).stdout.strip()
    if not key:
        return False
    r = subprocess.run(["curl","-s","-m","240","-o",OUT,"-w","%{http_code} %{content_type}",
        "-X","POST","https://mcp.baisoln.com/gpu-ai/v1/audio/music",
        "-H",f"X-API-Key: {key}","-H","Content-Type: application/json",
        "-d",json.dumps({"tags":TAGS,"duration":SECONDS})], capture_output=True, text=True)
    code_ct = r.stdout.strip()
    if code_ct.startswith("200") and "audio" in code_ct and os.path.getsize(OUT) > 10000:
        print(f"DONE (gpu-ai REST) -> {OUT} ({os.path.getsize(OUT)} bytes)")
        return True
    print(f"gpu-ai REST music unavailable ({code_ct}); falling back to ComfyUI…")
    return False

if try_rest():
    sys.exit(0)

def get(path):
    r = subprocess.run(["curl","-s","-m","20",f"{COMFY}{path}"],capture_output=True,text=True)
    return r.stdout

# 1) guard: is the ACE-Step checkpoint installed?
oi = json.loads(get("/object_info/CheckpointLoaderSimple"))
ckpts = oi["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
if CKPT not in ckpts:
    print("ACE-Step checkpoint NOT installed yet. Available:", ckpts)
    print("Install it, then re-run. Aborting.")
    sys.exit(2)

# 2) build the ACE-Step text-to-music graph (ComfyUI API format)
g = {
  "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":CKPT}},
  "2": {"class_type":"EmptyAceStepLatentAudio","inputs":{"seconds":SECONDS,"batch_size":1}},
  "3": {"class_type":"TextEncodeAceStepAudio","inputs":{"clip":["1",1],"tags":TAGS,"lyrics":"","lyrics_strength":1.0}},
  "4": {"class_type":"TextEncodeAceStepAudio","inputs":{"clip":["1",1],"tags":"vocals, singing, lyrics, low quality, noise","lyrics":"","lyrics_strength":1.0}},
  "5": {"class_type":"KSampler","inputs":{
        "model":["1",0],"seed":42,"steps":50,"cfg":5.0,
        "sampler_name":"euler","scheduler":"simple",
        "positive":["3",0],"negative":["4",0],"latent_image":["2",0],"denoise":1.0}},
  "6": {"class_type":"VAEDecodeAudio","inputs":{"samples":["5",0],"vae":["1",2]}},
  "7": {"class_type":"SaveAudioMP3","inputs":{"audio":["6",0],"filename_prefix":"asre_music","quality":"320k"}},
}

# 3) submit
body = json.dumps({"prompt": g, "client_id": "asre-music"})
r = subprocess.run(["curl","-s","-m","30","-X","POST",f"{COMFY}/prompt",
     "-H","Content-Type: application/json","-d",body],capture_output=True,text=True)
resp = json.loads(r.stdout)
pid = resp.get("prompt_id")
print("submitted prompt_id:", pid, "| node_errors:", resp.get("node_errors"))
if not pid: sys.exit(1)

# 4) poll history
for i in range(120):
    h = json.loads(get(f"/history/{pid}") or "{}")
    if pid in h:
        outs = h[pid].get("outputs",{})
        for node, o in outs.items():
            for a in o.get("audio",[]):
                fn, sub, typ = a["filename"], a.get("subfolder",""), a.get("type","output")
                url = f"/view?filename={fn}&subfolder={sub}&type={typ}"
                subprocess.run(["curl","-s","-m","60","-o",OUT,f"{COMFY}{url}"])
                print(f"DONE (ComfyUI) -> {OUT} ({os.path.getsize(OUT)} bytes) from {fn}")
                sys.exit(0)
        st = h[pid].get("status",{})
        if st.get("status_str") == "error":
            print("workflow ERROR:", json.dumps(st)[:400]); sys.exit(1)
    time.sleep(10)
print("timed out waiting for music")
