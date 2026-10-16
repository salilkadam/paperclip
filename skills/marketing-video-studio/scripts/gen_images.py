#!/usr/bin/env python3
"""Generate one cinematic 16:9 still per scene via the GenImage MCP server.

Reads scene_images.json (a JSON array of image-prompt strings, one per scene) and
writes img1.png .. imgN.png. Retries failed scenes once. Uses the default model
(fast); do NOT pass a FLUX-dev model here — it times out.

Env:
  PROMPTS  path to image-prompt json (default scene_images.json)
  W,H      dimensions (default 1024x576, 16:9; both must be multiples of 16)
Requires MCP_API_KEY (platform-provided).
"""
import os, json, subprocess, re, base64, os

URL = "https://mcp.baisoln.com/genimage/mcp"
W = int(os.environ.get("W", "1024")); H = int(os.environ.get("H", "576"))
PROMPTS = os.environ.get("PROMPTS", "scene_images.json")
key = os.environ.get("MCP_API_KEY","").strip() or subprocess.run(["bash", os.path.join(os.path.dirname(os.path.abspath(__file__)), "get_key.sh")],
    capture_output=True, text=True).stdout.strip()
HDR = ["-H", f"X-API-Key: {key}", "-H", "Content-Type: application/json",
       "-H", "Accept: application/json, text/event-stream"]
prompts = json.load(open(PROMPTS))

def init():
    b = json.dumps({"jsonrpc":"2.0","method":"initialize","id":1,"params":{
        "protocolVersion":"2024-11-05","capabilities":{},
        "clientInfo":{"name":"create-infomercial","version":"1.0"}}})
    r = subprocess.run(["curl","-s","-D-","-X","POST",URL,*HDR,"-d",b], capture_output=True, text=True)
    for l in r.stdout.splitlines():
        if l.lower().startswith("mcp-session-id:"):
            return l.split(":",1)[1].strip()

def extract(raw):
    found = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            try: obj = json.loads(line[5:].strip())
            except Exception: continue
            def walk(o):
                if isinstance(o, dict):
                    for k, v in o.items():
                        if k in ("image_data","imageBase64","b64_json") and isinstance(v, str) and len(v) > 1000:
                            found.append(v)
                        else: walk(v)
                elif isinstance(o, list):
                    for v in o: walk(v)
                elif isinstance(o, str) and o.strip().startswith("{") and "image" in o:
                    try: walk(json.loads(o))
                    except Exception: pass
            walk(obj)
    return found[0] if found else None

def gen_one(sid, i, prompt):
    body = json.dumps({"jsonrpc":"2.0","method":"tools/call","id":i+1,"params":{
        "name":"gi_generate_image","arguments":{"tenant_id":"base","prompt":prompt,
        "width":W,"height":H,"steps":28,"cfg_scale":5.0}}})
    hdr = HDR + ["-H", f"Mcp-Session-Id: {sid}"]
    r = subprocess.run(["curl","-s","-m","240","-X","POST",URL,*hdr,"-d",body], capture_output=True, text=True)
    b64 = extract(r.stdout)
    if not b64:
        return False, r.stdout[-160:]
    open(f"img{i}.png","wb").write(base64.b64decode(re.sub(r"^data:image/\w+;base64,","",b64)))
    return True, None

sid = init()
ok = 0
for i, p in enumerate(prompts, 1):
    success, err = gen_one(sid, i, p)
    if not success:
        sid = init()  # fresh session, retry once
        success, err = gen_one(sid, i, p)
    print(f"scene{i}: {'OK' if success else 'FAIL ' + str(err)[:120]}")
    ok += success
print(f"DONE {ok}/{len(prompts)} -> img*.png")
