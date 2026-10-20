import { describe, expect, it, vi } from "vitest";

import { SesError, buildSendRawBody, parseSesResponse, sendRawViaSes } from "./ses.js";

const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secretvalue" };
const RAW = "From: support@reliora.ai\r\nTo: human@gmail.example\r\n\r\nbody\r\n";

function sesOk(messageId = "abcdef0123") {
  return `<SendRawEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendRawEmailResult><MessageId>${messageId}</MessageId></SendRawEmailResult><ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata></SendRawEmailResponse>`;
}

describe("buildSendRawBody", () => {
  it("names the envelope sender and every recipient explicitly", () => {
    const body = buildSendRawBody({
      rawMessage: RAW,
      source: "support@reliora.ai",
      recipients: ["human@gmail.example", "founders@reliora.ai"],
    });
    const params = new URLSearchParams(body);
    expect(params.get("Source")).toBe("support@reliora.ai");
    expect(params.get("Destinations.member.1")).toBe("human@gmail.example");
    expect(params.get("Destinations.member.2")).toBe("founders@reliora.ai");
    expect(params.get("RawMessage.Data")).toBe(Buffer.from(RAW, "utf8").toString("base64"));
    expect(params.get("ConfigurationSetName")).toBeNull();
  });

  it("adds the configuration set when the operator configured one", () => {
    const body = buildSendRawBody({
      rawMessage: RAW,
      source: "support@reliora.ai",
      recipients: ["human@gmail.example"],
      configurationSet: " agentmail ",
    });
    expect(new URLSearchParams(body).get("ConfigurationSetName")).toBe("agentmail");
  });
});

describe("parseSesResponse", () => {
  it("returns the provider message id on success", () => {
    expect(parseSesResponse(200, sesOk("msg-1"))).toEqual({ messageId: "msg-1" });
  });

  it("treats a success body without an id as a failure", () => {
    expect(() => parseSesResponse(200, "<html>not ses</html>")).toThrow(/without a message id/);
  });

  it("surfaces the SES error code and message", () => {
    const body =
      "<ErrorResponse><Error><Code>MessageRejected</Code><Message>Mail from domain not verified</Message></Error></ErrorResponse>";
    expect(() => parseSesResponse(400, body)).toThrow(/MessageRejected/);
    expect(() => parseSesResponse(400, body)).toThrow(/Mail from domain not verified/);
    expect(() => parseSesResponse(400, body)).toThrow(SesError);
  });

  it("falls back to the status when the body is unparseable", () => {
    expect(() => parseSesResponse(503, "Service Unavailable")).toThrow(/HTTP 503/);
  });
});

describe("sendRawViaSes", () => {
  it("posts a signed SendRawEmail to the regional endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(sesOk("msg-42"), { status: 200 })) as unknown as typeof fetch;
    const result = await sendRawViaSes({
      region: "us-east-1",
      credentials: CREDENTIALS,
      rawMessage: RAW,
      source: "support@reliora.ai",
      recipients: ["human@gmail.example"],
      fetchImpl,
    });
    expect(result).toEqual({ messageId: "msg-42" });

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://email.us-east-1.amazonaws.com/?Action=SendRawEmail&Version=2010-12-01");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toContain("Credential=AKIDEXAMPLE");
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded;charset=utf-8");
    expect(Number(headers["content-length"])).toBe(Buffer.byteLength(init.body as string, "utf8"));
  });

  it("targets the endpoint of whatever region is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(sesOk("x"), { status: 200 })) as unknown as typeof fetch;
    await sendRawViaSes({
      region: "eu-central-1",
      credentials: CREDENTIALS,
      rawMessage: RAW,
      source: "s@r.ai",
      recipients: ["a@b.example"],
      fetchImpl,
    });
    const [url] = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]!;
    expect(url).toContain("email.eu-central-1.amazonaws.com");
  });

  it("reports a transport failure with the endpoint it could not reach", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ETIMEDOUT");
    }) as unknown as typeof fetch;
    await expect(
      sendRawViaSes({
        region: "us-east-1",
        credentials: CREDENTIALS,
        rawMessage: RAW,
        source: "s@r.ai",
        recipients: ["a@b.example"],
        fetchImpl,
      }),
    ).rejects.toThrow(/could not reach SES at email\.us-east-1\.amazonaws\.com.*ETIMEDOUT/s);
  });

  it("refuses to try without a region or recipients", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      sendRawViaSes({ region: "", credentials: CREDENTIALS, rawMessage: RAW, source: "s@r.ai", recipients: ["a@b.example"], fetchImpl }),
    ).rejects.toThrow(/region is not configured/);
    await expect(
      sendRawViaSes({ region: "us-east-1", credentials: CREDENTIALS, rawMessage: RAW, source: "s@r.ai", recipients: [], fetchImpl }),
    ).rejects.toThrow(/no recipients/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
