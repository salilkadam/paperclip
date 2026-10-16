#!/usr/bin/env python3
"""Upload assets to MinIO and presign GET URLs that avatalk can fetch.

avatalk can't take base64 or resolve cluster-internal DNS, but it CAN reach the
public s3.baisoln.com ingress. So we upload and presign against that one host
(presigning is offline maths — the signed URL's host is exactly what avatalk
fetches). See references/pipeline.md §7.

Uploads every img*.png and scene*.wav in the cwd, plus any extra files passed as
argv. Writes/merges presigned.json (filename -> presigned GET url, 24h).

Env (inside Paperclip these are platform-provided via Vault -> External Secrets):
  MEDIA_S3_ACCESS_KEY / MEDIA_S3_SECRET_KEY   scoped media-bucket credentials
  MEDIA_S3_BUCKET     bucket (default "voice-studio")
  MEDIA_S3_ENDPOINT   S3 endpoint (default "https://s3.baisoln.com")
  PREFIX              object key prefix in the bucket (default "infomercial/")
MINIO_ACCESS_KEY / MINIO_SECRET_KEY / S3_ENDPOINT are accepted as fallbacks for
non-Paperclip environments. Never use MinIO root credentials here.
"""
import sys, json, glob, os
import boto3
from botocore.client import Config


def _env(*names, default=""):
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


BUCKET = _env("MEDIA_S3_BUCKET", default="voice-studio")
PREFIX = os.environ.get("PREFIX", "infomercial/")
S3_EP = _env("MEDIA_S3_ENDPOINT", "S3_ENDPOINT", default="https://s3.baisoln.com")
ACCESS = _env("MEDIA_S3_ACCESS_KEY", "MINIO_ACCESS_KEY")
SECRET = _env("MEDIA_S3_SECRET_KEY", "MINIO_SECRET_KEY")
if not (ACCESS and SECRET):
    sys.exit("ERROR: MEDIA_S3_ACCESS_KEY / MEDIA_S3_SECRET_KEY are not set. They are "
             "platform-provided (Vault via External Secrets); report the missing env "
             "vars to the operator instead of looking for other credentials.")

cfg = Config(signature_version="s3v4", s3={"addressing_style": "path"})
s3 = boto3.client("s3", endpoint_url=S3_EP, aws_access_key_id=ACCESS,
                  aws_secret_access_key=SECRET, config=cfg, region_name="us-east-1")

ctype = {"png": "image/png", "jpg": "image/jpeg", "wav": "audio/wav", "mp4": "video/mp4", "mp3": "audio/mpeg"}
files = sorted(glob.glob("img*.png")) + sorted(glob.glob("scene*.wav")) + list(sys.argv[1:])
urls = json.load(open("presigned.json")) if os.path.exists("presigned.json") else {}
for f in files:
    if not os.path.exists(f):
        print(f"skip (missing) {f}"); continue
    key = PREFIX + os.path.basename(f)
    s3.upload_file(f, BUCKET, key, ExtraArgs={"ContentType": ctype.get(f.rsplit(".", 1)[-1], "application/octet-stream")})
    urls[os.path.basename(f)] = s3.generate_presigned_url("get_object",
        Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=86400)
    print(f"uploaded {f}")
json.dump(urls, open("presigned.json", "w"), indent=1)
print(f"\n{len(urls)} objects presigned -> presigned.json  (bucket {BUCKET}, prefix {PREFIX})")
