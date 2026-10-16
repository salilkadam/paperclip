# Pipeline reference — endpoints, auth, voices, gotchas

All HTTP goes to `https://mcp.baisoln.com` with header `X-API-Key: $KEY` unless noted.

## Table of contents
1. Credentials
2. LLM
3. TTS + STT
4. Voice registry
5. GenImage
6. Music
7. MinIO presigning
8. avatalk
9. Gotchas

---

## 1. Credentials

Platform-provided environment variables. The operator keeps them in Vault and
External Secrets syncs them into the Paperclip pod, so every agent process inherits
them. Agents never fetch secrets from Vault or Kubernetes themselves.

| Env var | Source (Vault) | Used by |
|---|---|---|
| `MCP_API_KEY` | `shared/api-keys` → `mcp_api_key` | every `mcp.baisoln.com` call (`X-API-Key`) |
| `MEDIA_S3_ACCESS_KEY` / `MEDIA_S3_SECRET_KEY` | `t6-apps/voice-studio/config` → `minio_access_key` / `minio_secret_key` | `minio_upload.py` |
| `MEDIA_S3_BUCKET` | `t6-apps/voice-studio/config` → `minio_bucket` | `minio_upload.py` (default `voice-studio`) |
| `MEDIA_S3_ENDPOINT` | Helm value (non-secret) | `minio_upload.py` (default `https://s3.baisoln.com`) |

If one is missing, stop and report it to the operator. Do not hunt for other
credentials, and never use MinIO root credentials.

Verify the key with a cheap call before a long run: `GET /gpu-ai/v1/audio/voices`.
Scripts read secrets internally; never echo a key into a log or issue comment.

## 2. LLM

`POST /gpu-ai/v1/chat/completions`, model `qwen3.5-27b-fp8` (synthesis) or
`gemma-4-e4b-it` (fast). OpenAI-shaped. Use it to draft storyboards as JSON, or write
them yourself.

**Cold start:** vLLM engines sleep when idle, and a cold wake can exceed the ~100s
Cloudflare cap, giving 524/000 on the first call. The disconnect does *not* abort the
load — retry with backoff and a call 30-90s later hits a warm engine. Warm it early with
a throwaway "say READY" if you'll need it mid-pipeline.

## 3. TTS + STT

**Speech:** `POST /gpu-ai/v1/audio/speech`
```json
{"voice":"Jessica","input":"<text>","response_format":"wav"}
```
`voice` must exist in the registry or you get a 400 listing valid names. Long inputs can
502 — generate per scene, never one long call.

**Transcription:** `POST /gpu-ai/v1/audio/transcriptions` (multipart), `model=faster-whisper`.
Add `response_format=verbose_json` and `timestamp_granularities[]=segment` for segment
timings — useful for splitting a supplied master VO at silence gaps.

**Polish chain** applied to the chosen take:
```
atempo=<1.0>,acompressor=threshold=-20dB:ratio=3:attack=8:release=150,
treble=g=2:f=4500,loudnorm=I=-14:TP=-1.5:dual_mono=true
```
`atempo` is the runtime knob: 1.06 shaves ~6% inaudibly. Beyond ~1.12 it is audible.

## 4. Voice registry

`GET /gpu-ai/v1/audio/voices` → ~195 voices (response shape `data.voices[]`, each with
`name` and `engine`). Engines seen 2026-10: `localclone` (local clones), `local`,
`eleven` (ElevenLabs, frequently 502), `indian` (Indic voices), `openai`. Several names
(e.g. `Jessica`, `Lily`) exist on both `localclone` and `eleven`. The registry evolves:
list it rather than trusting this paragraph.

Starting points, but **probe rather than assume** (`scripts/voice_probe.sh`):

| Register | Candidates |
|---|---|
| Trailer / dramatic | `Don LaFontaine` |
| Warm, mature, sincere | `Julie Andrews`, `Morgan Freeman` |
| Energetic modern female | `Jessica`, `Lily`, `Bella`, `Matilda`, `Alice`, `Laura` |

Avoid Indic-model voices (`indian` engine, formerly `svara-tts-v1`) for English — they
inject Hindi. ElevenLabs voices sound
best but the engine is often down.

Pace varies ~12% across clean voices on identical text — duration from a probe is the
most useful selection signal.

**Registry metadata does not change when a clone is rebuilt.** `native_id`,
`registry_voice_id` and `created_at` stay identical while the underlying audio is
replaced. To detect a re-clone, re-run the same script and compare durations: one
observed rebuild cut total VO from 90.9s to 69.3s with *identical* quality scores.

## 5. GenImage

`POST /genimage/mcp` (Streamable-HTTP MCP): `initialize` → capture `Mcp-Session-Id` →
`tools/call` `gi_generate_image` with `tenant_id:"base"`, `prompt`, `width`, `height`
(multiples of 16; 1024×576 for 16:9, 768×1024 for portraits), `steps:28`, `cfg_scale:5`.
Result arrives as SSE; base64 in `image_data`. `scripts/gen_images.py` handles it.

Use the default model. **FLUX-dev times out.** Runware can transiently return polling
timeouts or wallet-balance errors — retry, and if balance is exhausted tell the user.

## 6. Music

`POST /gpu-ai/v1/audio/music` — **body field is `tags`, not `prompt`** (a `prompt` body
returns 422). Returns `audio/mpeg`. Caps at ~30s regardless of `duration`; assembly loops
it with `-stream_loop -1`.

A ComfyUI ACE-Step path exists as a fallback via in-cluster service DNS; if that DNS
does not resolve it fails with a JSON decode error on `/object_info`. Prefer the REST route.

## 7. MinIO presigning

avatalk fetches inputs by URL. It **cannot** take base64 (`URL too long`) or resolve
cluster-internal DNS (`Temporary failure in name resolution`). It *can* reach
`s3.baisoln.com`, so upload and presign against that one host. Path-style addressing,
`signature_version=s3v4`. Presigning is offline maths, so the signed URL's host is
exactly what avatalk fetches. `scripts/minio_upload.py` handles it; presigned URLs also
work from the agent runtime for verification.

## 8. avatalk

`GET /avatalk/v1/capabilities`, `POST /jobs`, `GET /jobs/{id}`, `DELETE /jobs/{id}`.
Tasks: `avatar`, `i2v`, `t2v`, `video.continue`, `video.long`, `refine`.

```json
{"task":"i2v","inputs":{"image":"<presigned>","prompt":"<motion>"},"params":{"resolution":"720p"}}
{"task":"avatar","inputs":{"image":"<presigned portrait>",
  "audio":{"source":"url","url":"<presigned VO>"}},
  "params":{"resolution":"720p","num_segments":"auto"}}
```

- **`audio.source:"tts"` is broken** — avatalk's `OMNIVOICE_URL` is a docker-compose
  alias the job container can't resolve. Always use `source:"url"`.
- Output is 640×640; i2v ~3.06s; avatar 16fps. **See `geometry.md` before submitting.**
- `video.continue` takes a *video* input, so extending an i2v clip is a second pass.
- Jobs are GPU-bound and strictly serial. Budget: i2v ~1 min, avatar ~5-8 min,
  `video.continue` 15-20 min. Cancel superseded jobs with DELETE to free the queue.
- Results are signed URLs, downloadable from the agent runtime.

## 9. Gotchas

- `MCP_API_KEY` / `MEDIA_S3_*` missing → platform config problem; report it, don't work around it.
- Chat LLM cold → 524. Retry with backoff; warm early.
- TTS long input → 502. Per scene.
- Cloned voices inject filler → best-of-N with STT scoring.
- Music body `prompt` → 422. Use `tags`.
- Music 502 → upstream ComfyUI ACE-Step out of GPU memory. Assemble without `music`, retry later, and say so when delivering.
- GenImage FLUX-dev → timeout. Default model.
- avatalk base64 or cluster DNS → fails. Presign via `s3.baisoln.com`.
- avatalk `source:tts` → name resolution failure. Use `source:url`.
- avatalk centre-crops and returns 16fps → **read `geometry.md`**.
- Concat without CFR-normalising first → dropped frames, truncated ending.
- Secret-decoding shell commands may be classifier-blocked → read secrets inside scripts.
