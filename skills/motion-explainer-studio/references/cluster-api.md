# Cluster API — endpoints, auth, and the failure modes worth knowing

Everything goes to `https://mcp.baisoln.com` with header `X-API-Key: $KEY`.
`scripts/lib/api.py` wraps all of it; this file is for when something breaks.

## Table of contents
1. Credentials
2. TTS and STT
3. Voice registry
4. Music
5. GenImage
6. LLM
7. Failure quick-reference

---

## 1. Credentials

`MCP_API_KEY` is platform-provided: the operator keeps it in Vault
(`shared/api-keys` → `mcp_api_key`), External Secrets syncs it into the Paperclip
pod, and every agent process inherits it. Agents never fetch secrets from Vault or
Kubernetes themselves. If it is missing, `scripts/get_key.sh` says so; stop and
report it rather than looking for other credentials.

Verify the key with a cheap call before starting a long run:

```bash
mes.py voices <dir>        # GET /gpu-ai/v1/audio/voices
```

A shell command that decodes a secret to stdout may be blocked by the permission
classifier. Have scripts read secrets internally rather than echoing them — which
is what `api.key()` does.

## 2. TTS and STT

**Speech** — `POST /gpu-ai/v1/audio/speech`

```json
{"voice": "Jessica", "input": "<text>", "response_format": "wav"}
```

`voice` must exist in the registry or you get a 400 listing valid names. **Long
inputs 502** — always generate per scene, never one long call. This is why the
pipeline is scene-shaped rather than one master VO track.

**Transcription** — `POST /gpu-ai/v1/audio/transcriptions` (multipart),
`model=faster-whisper`. Used by best-of-N scoring.

**Polish chain** applied to the winning take:

```
atempo=<1.0>,acompressor=threshold=-20dB:ratio=3:attack=8:release=150,
treble=g=2:f=4500,loudnorm=I=-14:TP=-1.5:dual_mono=true
```

`atempo` is the runtime knob — `edit project --set tempo=1.06` shaves ~6%
inaudibly. Past ~1.12 it is audible.

## 3. Voice registry

`GET /gpu-ai/v1/audio/voices` → ~195 voices (`data.voices[]`, each with `name` and
`engine`). Engines seen 2026-10: `localclone` (local clones), `local`, `eleven`,
`indian`, `openai`. The registry evolves — run `mes.py voices` rather than trusting
this list.

- Avoid Indic-model voices (`indian` engine, formerly `svara-tts-v1`) for English —
  they inject Hindi.
- ElevenLabs voices sound best but the engine is frequently 502.
- Pace varies >10% across clean voices on identical text. `mes.py probe` reports
  duration per voice; that is the most useful selection signal, more than timbre.

**Registry metadata does not change when a clone is rebuilt** — `native_id`,
`registry_voice_id` and `created_at` stay identical while the underlying audio is
replaced. You cannot detect a re-clone by inspecting the registry. Detect it by
re-running the same script and comparing durations.

Best-of-N exists because cloned voices are stochastic: they inject "uh"/"so" at
phrase boundaries and occasionally swallow a clause. `lib/voice.py` weights
*dropped* script words 4x, deliberately — a take that silently omits the URL or
half the CTA is short and fluent and would otherwise win. A non-zero score is not
automatically a defect: number formatting ("twenty third" heard as "23rd") and
unusual proper nouns inflate it. Read `vo_heard` in `project.json` before re-rolling.

## 4. Music

`POST /gpu-ai/v1/audio/music` — **the body field is `tags`, not `prompt`**; a
`prompt` body returns 422. Returns `audio/mpeg`, capped at ~30s regardless of the
`duration` you ask for. The assembler loops and ducks it.

Set the genre per project: `edit project --set music_tags="..."`. Music, voice and
visual style must agree — a trailer bed under a warm explainer reads as a mistake.

## 5. GenImage

`POST /genimage/mcp`, Streamable-HTTP MCP: `initialize` → capture `Mcp-Session-Id`
→ `tools/call` `gi_generate_image` with `tenant_id: "base"`, `prompt`, `width`,
`height` (multiples of 16), `steps: 28`, `cfg_scale: 5`. The result arrives as SSE
with base64 in `image_data`.

Use the default model. **FLUX-dev times out.** Runware can transiently return
polling timeouts or wallet-balance errors — retry once, and if the balance is
exhausted, say so rather than silently shipping a video with a missing image.

`lib/art.py` flood-fills the white surround to alpha from the frame edges. Edge
flood-fill rather than a global white→alpha replace, because a global replace also
punches holes in white shapes *inside* the illustration — shirt highlights, screen
fills, eyes — and you only notice once the art sits on a dark scene.

## 6. LLM

`POST /gpu-ai/v1/chat/completions`, model `qwen3.5-27b-fp8` (synthesis) or
`gemma-4-e4b-it` (fast), OpenAI-shaped. Optional here — you will usually write the
storyboard yourself, which is better.

**Cold start:** vLLM engines sleep when idle and a cold wake can exceed
Cloudflare's ~100s cap, returning 524 on the first call. The disconnect does *not*
abort the load — `api.chat()` retries with backoff, and a call 30-90s later hits a
warm engine. `api.warm()` sends a throwaway "say READY" if you know you will need
it mid-pipeline.

## 7. Failure quick-reference

| Symptom | Cause / fix |
|---|---|
| `MCP_API_KEY is not set` | platform config problem — report it to the operator |
| 401 mid-run | key rotated or lacks a scope. Re-verify with `mes.py voices`, then report |
| 524 on the first chat call | cold vLLM. Retry with backoff; warm early |
| 502 from TTS | input too long. Generate per scene |
| 400 from TTS listing names | voice not in the registry |
| 422 from music | body used `prompt`; it must be `tags` |
| Music shorter than asked | expected — caps at ~30s, the assembler loops it |
| 502 from music | upstream ComfyUI ACE-Step out of GPU memory (busy GPU). The cut builds narration-only; retry `mes.py music <dir> --force` later and re-assemble, and say so when delivering |
| GenImage timeout | FLUX-dev was requested. Use the default model |
| Hindi in English narration | Indic-model voice. Pick another |
