/**
 * AWS Signature Version 4 for the one call this connector makes
 * (`ses:SendRawEmail`).
 *
 * Signing by hand keeps the plugin bundle free of the AWS SDK, which is a
 * multi-megabyte dependency for a single HTTP request. Node's own `crypto`
 * provides HMAC-SHA256 and SHA-256, and the algorithm is fully specified at
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-signing-process.html
 */

import { createHmac, createHash } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const EMPTY_SHA256 = sha256Hex("");

/** Credentials for one signed request. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for temporary credentials (STS, IAM roles, SSO). */
  sessionToken?: string;
}

/** Input for {@link signAwsRequest}. */
export interface AwsRequestToSign {
  host: string;
  path: string;
  region: string;
  service: string;
  query: Record<string, string>;
  body: string;
  contentType: string;
  credentials: AwsCredentials;
  /** Injectable for deterministic tests. */
  date?: Date;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/**
 * AWS canonical URI encoding.
 *
 * `encodeURIComponent` keeps `!'()*`, which AWS requires percent-encoded, and
 * percent-encodes `~`, which AWS requires literal.
 */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, "~");
}

/** Canonical query string: keys and values encoded, pairs sorted by key. */
export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([key, value]) => [awsUriEncode(key), awsUriEncode(value)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** `20260101T010203Z` */
export function amzTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** `20260101` */
export function dateStamp(date: Date): string {
  return amzTimestamp(date).slice(0, 8);
}

/** Derive the signing key for a scope. */
export function signingKey(secretAccessKey: string, stamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, stamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Produce the headers that sign a request, including `Authorization`.
 *
 * Exposed separately from the transport so the canonical-request formatting can
 * be asserted in tests.
 */
export function buildSignedHeaders(input: AwsRequestToSign): Record<string, string> {
  const { credentials } = input;
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new Error("AWS credentials are incomplete: access key id and secret access key are both required");
  }
  const date = input.date ?? new Date();
  const amzDate = amzTimestamp(date);
  const stamp = dateStamp(date);
  const scope = `${stamp}/${input.region}/${input.service}/aws4_request`;

  const headers: Record<string, string> = {
    "content-type": input.contentType,
    host: input.host,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = `${headerNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join("")}`;
  const signedHeaders = headerNames.join(";");
  const canonicalRequest = [
    "POST",
    input.path || "/",
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join("\n");

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(credentials.secretAccessKey, stamp, input.region, input.service), stringToSign).toString("hex");

  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Signed request headers with the empty-body constant precomputed lazily. */
export const EMPTY_PAYLOAD_SHA256 = EMPTY_SHA256;
