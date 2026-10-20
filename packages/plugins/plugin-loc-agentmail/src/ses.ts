/**
 * AWS SES `SendRawEmail` over the query protocol.
 *
 * Raw send is deliberate: the connector builds the MIME itself so `From:`
 * matches the mailbox (DKIM/SPF alignment for DMARC) and `In-Reply-To` /
 * `References` survive, which a JSON body API would drop.
 *
 * Mail never transits the receive server on purpose. While that server hosts a
 * domain it is authoritative for it, so anything it sends to a recipient at the
 * same domain would be resolved locally and bounce.
 */

import { buildSignedHeaders, awsUriEncode, type AwsCredentials } from "./sigv4.js";

/** Raised when SES rejects a send; message text is safe to show an agent. */
export class SesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SesError";
  }
}

/** Parameters for one raw send. */
export interface SendRawParams {
  region: string;
  credentials: AwsCredentials;
  /** Complete RFC 822 message from `buildRawMessage`. */
  rawMessage: string;
  /** Envelope sender; must be verified in SES. */
  source: string;
  /** Every RCPT TO recipient: to + cc + bcc. */
  recipients: string[];
  /** Optional SES Configuration Set for deliverability reporting. */
  configurationSet?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const SES_API_VERSION = "2010-12-01";

/** Build the form body: envelope sender, explicit recipients, raw message. */
export function buildSendRawBody(
  params: Pick<SendRawParams, "rawMessage" | "source" | "recipients" | "configurationSet">,
): string {
  const pairs: [string, string][] = [["Source", params.source]];
  params.recipients.forEach((recipient, index) => {
    pairs.push([`Destinations.member.${index + 1}`, recipient]);
  });
  const configurationSet = (params.configurationSet ?? "").trim();
  if (configurationSet) pairs.push(["ConfigurationSetName", configurationSet]);
  pairs.push(["RawMessage.Data", Buffer.from(params.rawMessage, "utf8").toString("base64")]);
  return pairs.map(([key, value]) => `${awsUriEncode(key)}=${awsUriEncode(value)}`).join("&");
}

/** Pull `<MessageId>` or the `<Code>`/`<Message>` pair out of SES XML. */
export function parseSesResponse(status: number, body: string): { messageId: string } {
  const messageId = /<MessageId>([^<]+)<\/MessageId>/.exec(body)?.[1];
  if (status >= 200 && status < 300) {
    if (!messageId) throw new SesError(`SES returned ${status} without a message id`);
    return { messageId };
  }
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? `HTTP ${status}`;
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] ?? body.slice(0, 300);
  throw new SesError(`SES rejected the send (${code}): ${message}`);
}

/** Send a message through SES and return the SES message id. */
export async function sendRawViaSes(params: SendRawParams): Promise<{ messageId: string }> {
  const region = (params.region || "").trim();
  if (!region) throw new SesError("SES region is not configured");
  if (params.recipients.length === 0) throw new SesError("no recipients to deliver to");

  const host = `email.${region}.amazonaws.com`;
  const query = { Action: "SendRawEmail", Version: SES_API_VERSION };
  const body = buildSendRawBody(params);
  const headers = buildSignedHeaders({
    host,
    path: "/",
    region,
    service: "email",
    query,
    body,
    contentType: "application/x-www-form-urlencoded;charset=utf-8",
    credentials: params.credentials,
  });

  const url = `https://${host}/?Action=${query.Action}&Version=${query.Version}`;
  const doFetch = params.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body, "utf8")) },
      body,
      signal: params.signal,
    });
  } catch (error) {
    throw new SesError(`could not reach SES at ${host}: ${(error as Error).message}`);
  }
  const text = await response.text();
  return parseSesResponse(response.status, text);
}
