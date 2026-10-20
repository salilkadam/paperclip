import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EMPTY_PAYLOAD_SHA256,
  amzTimestamp,
  awsUriEncode,
  buildSignedHeaders,
  canonicalQuery,
  dateStamp,
  signingKey,
} from "./sigv4.js";

const FIXED_DATE = new Date("2026-01-01T01:02:03.000Z");
const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

function signRequest(overrides: Record<string, unknown> = {}) {
  return buildSignedHeaders({
    host: "email.us-east-1.amazonaws.com",
    path: "/",
    region: "us-east-1",
    service: "email",
    query: { Action: "SendRawEmail", Version: "2010-12-01" },
    body: "Source=a%40b.example",
    contentType: "application/x-www-form-urlencoded;charset=utf-8",
    credentials: CREDENTIALS,
    date: FIXED_DATE,
    ...overrides,
  });
}

describe("awsUriEncode", () => {
  it("follows the AWS canonical URI encoding rules", () => {
    expect(awsUriEncode("a b/c")).toBe("a%20b%2Fc");
    // AWS keeps tilde literal where encodeURIComponent escapes it.
    expect(awsUriEncode("~tilde")).toBe("~tilde");
    // And requires these to be escaped where encodeURIComponent leaves them.
    expect(awsUriEncode("a!'()*b")).toBe("a%21%27%28%29%2Ab");
    expect(awsUriEncode("support@reliora.ai")).toBe("support%40reliora.ai");
    expect(awsUriEncode("Destinations.member.1")).toBe("Destinations.member.1");
  });
});

describe("canonicalQuery", () => {
  it("encodes and sorts every pair", () => {
    expect(
      canonicalQuery({
        Version: "2010-12-01",
        Action: "SendRawEmail",
        "Destinations.member.2": "c@d.example",
        "Destinations.member.1": "a@b.example",
      }),
    ).toBe(
      "Action=SendRawEmail&Destinations.member.1=a%40b.example&Destinations.member.2=c%40d.example&Version=2010-12-01",
    );
    expect(canonicalQuery({})).toBe("");
  });
});

describe("timestamps", () => {
  it("formats x-amz-date and the credential scope stamp", () => {
    expect(amzTimestamp(FIXED_DATE)).toBe("20260101T010203Z");
    expect(dateStamp(FIXED_DATE)).toBe("20260101");
  });
});

describe("signingKey", () => {
  it("produces a 32-byte key that is stable and scope-specific", () => {
    const key = signingKey(CREDENTIALS.secretAccessKey, "20260101", "us-east-1", "email");
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(signingKey(CREDENTIALS.secretAccessKey, "20260101", "us-east-1", "email").toString("hex"));
    expect(key.toString("hex")).not.toBe(signingKey(CREDENTIALS.secretAccessKey, "20260101", "eu-west-1", "email").toString("hex"));
    expect(key.toString("hex")).not.toBe(signingKey(CREDENTIALS.secretAccessKey, "20260102", "us-east-1", "email").toString("hex"));
    expect(key.toString("hex")).not.toBe(signingKey("other", "20260101", "us-east-1", "email").toString("hex"));
  });
});

describe("buildSignedHeaders", () => {
  it("signs with SigV4 in the documented shape", () => {
    const headers = signRequest();
    expect(headers["x-amz-date"]).toBe("20260101T010203Z");
    expect(headers.host).toBe("email.us-east-1.amazonaws.com");
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260101\/us-east-1\/email\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("includes a session token in the signature when the credentials are temporary", () => {
    const headers = signRequest({ credentials: { ...CREDENTIALS, sessionToken: "token/with/slash" } });
    expect(headers["x-amz-security-token"]).toBe("token/with/slash");
    // A header that is not signed would be free to tamper with.
    expect(headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token");
  });

  it("is deterministic for one request and different for another", () => {
    expect(signRequest().authorization).toBe(signRequest().authorization);
    expect(signRequest({ body: "Source=other%40b.example" }).authorization).not.toBe(signRequest().authorization);
    expect(signRequest({ query: { Action: "SendEmail", Version: "2010-12-01" } }).authorization).not.toBe(
      signRequest().authorization,
    );
    expect(signRequest({ date: new Date("2026-01-01T01:02:04.000Z") }).authorization).not.toBe(
      signRequest().authorization,
    );
  });

  it("signs the region into the scope so a replay elsewhere fails", () => {
    expect(signRequest({ region: "eu-west-1" }).authorization).toContain("Credential=AKIDEXAMPLE/20260101/eu-west-1/email/");
  });

  it("refuses to sign with incomplete credentials", () => {
    expect(() => signRequest({ credentials: { accessKeyId: "", secretAccessKey: "x" } })).toThrow(/incomplete/);
    expect(() => signRequest({ credentials: { accessKeyId: "x", secretAccessKey: "" } })).toThrow(/incomplete/);
  });
});

describe("EMPTY_PAYLOAD_SHA256", () => {
  it("is the SHA-256 of the empty string", () => {
    expect(EMPTY_PAYLOAD_SHA256).toBe(createHash("sha256").update("", "utf8").digest("hex"));
    expect(EMPTY_PAYLOAD_SHA256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
