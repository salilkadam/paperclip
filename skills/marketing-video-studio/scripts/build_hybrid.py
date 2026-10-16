#!/usr/bin/env python3
"""Manifest-driven hybrid infomercial assembler (Tier H).

One command turns a scene manifest + rendered assets into the final MP4:
per-scene clip → CFR-normalize → concat → music duck → fades → fade-to-black.
Bakes in every hard-won gotcha (see references/assembly.md):
  - avatalk output is 640x640 square / VFR  -> crop to 16:9, normalize to CFR 30
  - avatar bg still MUST be input with -loop 1 (else overlay shortest=1 -> 1 frame)
  - drive each clip's duration off its AUDIO; pad video by cloning last frame
  - normalize every clip before `-c copy` concat or frames drop & the end cuts off
  - loop the music bed (~30s) under the voice with sidechain ducking + end fades

Usage:  python3 build_hybrid.py [manifest.json]

manifest.json:
{
  "output": "final.mp4",
  "music": "ace_music.mp3",        // optional; omit for no music bed
  "music_volume": 0.52,            // optional (0.45-0.62 typical)
  "tail": 0.5,                     // optional broll tail seconds after VO
  "font": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "scenes": [
    {"name":"s1","type":"broll","clip":"clips/s1.mp4","vo":"vo/s1.wav",
     "caption":"3 AM.","sub":""},
    {"name":"s3","type":"avatar","clip":"clips/s3.mp4",
     "caption":"Meet Agentic AI SRE","sub":"Autonomous Kubernetes remediation",
     "bg":"img3.png"},
    {"name":"s4","type":"still","still":"img4.png","vo":"vo/s4.wav",
     "caption":"Detect. Diagnose. Remediate.","sub":"","zoom":"in"}
  ]
}
Scene types:
  broll  - square/16:9 motion clip -> full-frame 16:9, boomerang+loop to VO len, VO audio
  avatar - square presenter clip composited over blurred `bg` still, clip's own audio
  still  - Ken-Burns zoom on a still (`zoom`: in|out), VO audio (Tier-A style scene)
"""
import json, subprocess, os, sys

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
NOCROP = "--no-crop" in sys.argv   # clips already un-padded to 16:9 (see geometry.md)
M = json.load(open(ARGS[0] if ARGS else "manifest.json"))
FONT = M.get("font", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
TAIL = float(M.get("tail", 0.5))
OUT = M.get("output", "final.mp4")
ENC = ["-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
       "-video_track_timescale","30000","-c:a","aac","-b:a","160k","-ar","48000"]

def dur(f):
    return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration",
        "-of","default=noprint_wrappers=1:nokey=1",f],capture_output=True,text=True).stdout or 0)
def adur(f):
    return float(subprocess.run(["ffprobe","-v","error","-select_streams","a:0","-show_entries",
        "stream=duration","-of","default=noprint_wrappers=1:nokey=1",f],capture_output=True,text=True).stdout or 0)
def esc(t):
    return t.replace("\\","\\\\").replace(":","\\:").replace("'","’")
def cap_f(cap, sub):
    f=(f"drawtext=fontfile={FONT}:text='{esc(cap)}':fontcolor=white:fontsize=52:"
       "box=1:boxcolor=black@0.45:boxborderw=22:x=(w-text_w)/2:y=h-165:"
       "alpha='if(lt(t,0.3),0,if(lt(t,0.7),(t-0.3)/0.4,1))'")
    if sub:
        f+=(f",drawtext=fontfile={FONT}:text='{esc(sub)}':fontcolor=0x9fe8c8:fontsize=30:"
            "x=(w-text_w)/2:y=h-98:alpha='if(lt(t,0.5),0,if(lt(t,0.9),(t-0.5)/0.4,1))'")
    return f

def normalize(raw, out):
    """Force CFR 30 at the clip's own audio length; clone last frame to fill gaps."""
    A = adur(raw)
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",raw,
        "-vf",f"tpad=stop_mode=clone:stop_duration=3,fps=30,trim=0:{A},setpts=PTS-STARTPTS",
        "-af",f"apad,atrim=0:{A},asetpts=PTS-STARTPTS","-r","30","-vsync","cfr","-t",str(A),
        *ENC,out],check=True)
    return A

clips=[]
for i, sc in enumerate(M["scenes"]):
    name = sc.get("name", f"s{i+1}")
    typ = sc["type"]
    capf = cap_f(sc.get("caption",""), sc.get("sub",""))
    raw = f".raw_{name}.mp4"
    if typ == "broll":
        T = round(adur(sc["vo"]) + TAIL, 2)
        crop = ("[0:v]scale=1280:720" if NOCROP else
                "[0:v]scale=1280:1280:force_original_aspect_ratio=increase,crop=1280:720")
        cd = dur(sc["clip"])
        # Always play the source FORWARD (no reverse boomerang, which reads as a
        # visible back-and-forth). If the clip is long enough, trim it; if it's
        # short, slow it (setpts) to fill the scene — gentle slow-motion, never a
        # seam. Best of all: generate genuinely longer source clips (avatalk
        # video.long / video.continue with num_segments) so little/no slowdown is
        # needed. `fillmode: "boomerang"` on a scene opts back into the old loop.
        if cd >= T - 0.15:
            motion = f"{crop},trim=0:{T},setpts=PTS-STARTPTS,fps=30"
        elif sc.get("fillmode") == "boomerang":
            motion = (f"{crop},split[f][b];[b]reverse[r];[f][r]concat=n=2:v=1:a=0,"
                      f"loop=loop=6:size=400:start=0,trim=0:{T},setpts=PTS-STARTPTS,fps=30")
        else:
            factor = round(T / cd, 4)  # slow forward to fill exactly
            motion = f"{crop},setpts={factor}*PTS,fps=30,trim=0:{T},setpts=PTS-STARTPTS"
        vf=(f"{motion},{capf},format=yuv420p[v];"
            f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:{T}[a]")
        subprocess.run(["ffmpeg","-y","-loglevel","error","-i",sc["clip"],"-i",sc["vo"],
            "-filter_complex",vf,"-map","[v]","-map","[a]","-t",str(T),*ENC,raw],check=True)
    elif typ == "avatar":
        T = round(dur(sc["clip"]), 2)
        vf=(f"[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,"
            f"boxblur=26:2,eq=brightness=-0.30:saturation=0.85[bg];"
            f"[1:v]scale=720:720,fps=30[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[ov];"
            f"[ov]{capf},format=yuv420p[v];"
            f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad[a]")
        subprocess.run(["ffmpeg","-y","-loglevel","error","-loop","1","-i",sc["bg"],"-i",sc["clip"],
            "-filter_complex",vf,"-map","[v]","-map","[a]","-t",str(T),*ENC,raw],check=True)
    elif typ == "still":
        T = round(adur(sc["vo"]) + TAIL, 2); frames = round(T*30)
        z = ("min(1.0+0.0010*on,1.14)" if sc.get("zoom","in")=="in" else "max(1.14-0.0010*on,1.0)")
        vf=(f"[0:v]scale=2560:1440,zoompan=z='{z}':d={frames}:x='iw/2-(iw/zoom/2)':"
            f"y='ih/2-(ih/zoom/2)':s=1280x720:fps=30,{capf},format=yuv420p[v];"
            f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:{T}[a]")
        subprocess.run(["ffmpeg","-y","-loglevel","error","-loop","1","-i",sc["still"],"-i",sc["vo"],
            "-filter_complex",vf,"-map","[v]","-map","[a]","-t",str(T),*ENC,raw],check=True)
    else:
        sys.exit(f"unknown scene type: {typ}")
    out=f".n_{name}.mp4"; A=normalize(raw, out); clips.append(out)
    print(f"{name} ({typ}) -> {round(A,2)}s")

with open(".vlist.txt","w") as fh:
    for c in clips: fh.write(f"file '{os.path.abspath(c)}'\n")
subprocess.run(["ffmpeg","-y","-loglevel","error","-f","concat","-safe","0","-i",".vlist.txt",
    "-c","copy",".body.mp4"],check=True)
D = dur(".body.mp4")
print(f"body: {round(D,2)}s")

music = M.get("music")
if music and os.path.exists(music):
    vol = M.get("music_volume", 0.52)
    MF=max(0,D-2.8); AF=max(0,D-2.0)
    fc=(f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{D},asetpts=PTS-STARTPTS,"
        f"volume={vol},afade=t=out:st={MF}:d=2.8[mus];"
        f"[0:a]aformat=sample_rates=48000:channel_layouts=stereo[vo];[vo]asplit=2[vomix][vokey];"
        f"[mus][vokey]sidechaincompress=threshold=0.09:ratio=4:attack=25:release=450:makeup=1[musd];"
        f"[vomix][musd]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-13:TP=-1.5,"
        f"afade=t=out:st={AF}:d=2.0[aout]")
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",".body.mp4","-stream_loop","-1","-i",music,
        "-filter_complex",fc,"-map","0:v","-map","[aout]","-t",str(D),
        "-c:v","copy","-c:a","aac","-b:a","192k",".muxed.mp4"],check=True)
    src=".muxed.mp4"
else:
    print("no music bed; skipping music mux"); src=".body.mp4"

ST=max(0,D-2.0)
subprocess.run(["ffmpeg","-y","-loglevel","error","-i",src,"-vf",f"fade=t=out:st={ST}:d=2.0",
    "-c:v","libx264","-crf","20","-preset","medium","-pix_fmt","yuv420p","-c:a","copy",OUT],check=True)
print(f"DONE -> {OUT}  {round(dur(OUT),2)}s  "
      f"{subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0:s=x',OUT],capture_output=True,text=True).stdout.strip()}")
