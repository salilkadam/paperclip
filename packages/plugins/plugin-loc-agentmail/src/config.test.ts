import { describe, expect, it } from "vitest";

import {
  AuthorizationError,
  ConfigError,
  accountsForAgent,
  authorizeAccount,
  findAccount,
  parseConfig,
} from "./config.js";

const COMPANY_A = "62d63984-df6c-49be-981c-1273f68a451c";
const COMPANY_B = "370325c2-a341-47fe-9ae2-bce9b5dd446f";
const AGENT_CEO = "73cae9f9-b419-48f1-b395-7e7e8c41048d";
const AGENT_COO = "70499d70-c8de-4a11-b75f-70596e18e7e2";

function minimalConfig() {
  return {
    imap: { host: "agentmail-gw.bionicorg.svc.cluster.local" },
    send: {
      transport: "ses-api",
      sesRegion: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secretvalue",
    },
    accounts: [
      {
        key: "rel-support",
        address: "Support@AgentMail.Reliora.ai",
        password: "mailbox-secret",
        companyIds: [COMPANY_A],
      },
    ],
  };
}

describe("parseConfig", () => {
  it("fills in the defaults an operator should not have to type", () => {
    const config = parseConfig(minimalConfig());
    expect(config.imap).toMatchObject({
      host: "agentmail-gw.bionicorg.svc.cluster.local",
      port: 993,
      tlsMode: "implicit",
      rejectUnauthorized: true,
      timeoutMs: 20000,
      mailbox: "INBOX",
    });
    expect(config.accounts[0]).toMatchObject({
      key: "rel-support",
      address: "support@agentmail.reliora.ai",
      fromAddress: "support@agentmail.reliora.ai",
      imapUser: "Support@AgentMail.Reliora.ai",
      replyTo: [],
      agentIds: [],
    });
    expect(config.poll).toEqual({ enabled: true, maxMessagesPerAccount: 25, markSeen: false });
    expect(config.send.transport).toBe("ses-api");
  });

  it("reports every problem at once instead of one per save", () => {
    const raw = {
      imap: { host: "", port: 99999, tlsMode: "starttls", timeoutMs: 5 },
      send: { transport: "ses-api" },
      accounts: [
        { key: "Bad Key", address: "nope", password: "x", companyIds: [] },
        { key: "bad-key", address: "a@b.example", password: "y", companyIds: ["not-a-uuid"] },
        { key: "bad-key", address: "a@b.example", password: "z", companyIds: [COMPANY_A] },
      ],
      poll: { maxMessagesPerAccount: 5000 },
    };
    let message = "";
    try {
      parseConfig(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    for (const expected of [
      "imap.host is required",
      "imap.port must be an integer between 1 and 65535",
      "tlsMode must be one of implicit, none",
      "imap.timeoutMs",
      "send.sesRegion",
      "send.accessKeyId is required",
      "send.secretAccessKey is required",
      "must be a lowercase slug",
      "is not a valid email address",
      "is duplicated",
      "companyIds must name at least one company",
      "not-a-uuid",
      "poll.maxMessagesPerAccount",
    ]) {
      expect(message).toContain(expected);
    }
    // One save names every defect, so the operator fixes them in one pass.
    expect(message.split("\n- ").length).toBeGreaterThan(10);
  });

  it("accepts a saved-secret binding in place of a pasted password", () => {
    const raw = minimalConfig();
    raw.accounts[0]!.password = { type: "secret_ref", secretId: COMPANY_A, version: "latest" };
    raw.send.accessKeyId = { type: "secret_ref", secretId: COMPANY_B };
    expect(() => parseConfig(raw)).not.toThrow();
  });

  it("refuses plaintext IMAP except against a loopback host", () => {
    const raw = minimalConfig();
    raw.imap.tlsMode = "none" as never;
    expect(() => parseConfig(raw)).toThrow(/in the clear/);
    raw.imap.host = "127.0.0.1";
    expect(parseConfig(raw).imap.tlsMode).toBe("none");
    raw.imap.host = "::1";
    expect(parseConfig(raw).imap.tlsMode).toBe("none");
  });

  it("does not demand SES credentials from a receive-only install", () => {
    const raw = minimalConfig();
    raw.send = { transport: "disabled" } as never;
    const config = parseConfig(raw);
    expect(config.send.transport).toBe("disabled");
    expect(config.send.accessKeyId).toBeNull();
  });

  it("requires a password and at least one mailbox", () => {
    const raw = minimalConfig();
    raw.accounts[0]!.password = undefined as never;
    expect(() => parseConfig(raw)).toThrow(/accounts\[0\].password is required/);
    expect(() => parseConfig({ ...minimalConfig(), accounts: [] })).toThrow(/at least one mailbox/);
  });

  it("accepts comma-separated lists and lowercases addresses", () => {
    const raw = minimalConfig();
    raw.accounts[0]!.replyTo = "Founders@Reliora.ai, billing@reliora.ai" as never;
    const config = parseConfig(raw);
    expect(config.accounts[0]?.replyTo).toEqual(["founders@reliora.ai", "billing@reliora.ai"]);
  });

  it("keeps the account array order, which the secret config paths depend on", () => {
    const raw = minimalConfig();
    raw.accounts.push({ key: "rel-info", address: "info@agentmail.reliora.ai", password: "p2", companyIds: [COMPANY_A] });
    const config = parseConfig(raw);
    expect(config.accounts.map((account) => account.key)).toEqual(["rel-support", "rel-info"]);
    expect(config.accounts.indexOf(config.accounts[1]!)).toBe(1);
  });
});

describe("findAccount", () => {
  const config = parseConfig(minimalConfig());

  it("resolves the key an agent typed, trimming and case", () => {
    expect(findAccount(config, "  REL-Support ").key).toBe("rel-support");
  });

  it("names the configured mailboxes when the key is wrong", () => {
    expect(() => findAccount(config, "billing")).toThrow(AuthorizationError);
    expect(() => findAccount(config, "billing")).toThrow(/Configured mailboxes: rel-support/);
    expect(() => findAccount(config, "")).toThrow(/unknown mailbox/);
  });
});

describe("authorizeAccount", () => {
  const config = parseConfig(minimalConfig());
  const account = config.accounts[0]!;

  it("refuses a mailbox from another company", () => {
    expect(() => authorizeAccount(account, { companyId: COMPANY_B, agentId: AGENT_CEO })).toThrow(
      /not available to this company/,
    );
  });

  it("treats an empty agent list as the whole company", () => {
    expect(() => authorizeAccount(account, { companyId: COMPANY_A, agentId: AGENT_COO })).not.toThrow();
  });

  it("honours the allowlist when one is configured", () => {
    const restricted = { ...account, agentIds: [AGENT_CEO] };
    expect(() => authorizeAccount(restricted, { companyId: COMPANY_A, agentId: AGENT_CEO })).not.toThrow();
    expect(() => authorizeAccount(restricted, { companyId: COMPANY_A, agentId: AGENT_COO })).toThrow(
      /not assigned to this agent/,
    );
  });
});

describe("accountsForAgent", () => {
  it("returns only the mailboxes this agent may act as", () => {
    const config = parseConfig({
      ...minimalConfig(),
      accounts: [
        { key: "rel-info", address: "info@agentmail.reliora.ai", password: "a", companyIds: [COMPANY_A], agentIds: [AGENT_CEO] },
        { key: "rel-support", address: "support@agentmail.reliora.ai", password: "b", companyIds: [COMPANY_A], agentIds: [AGENT_COO] },
        { key: "rel-shared", address: "hello@agentmail.reliora.ai", password: "c", companyIds: [COMPANY_A] },
        { key: "bai-info", address: "info@agentmail.baisoln.com", password: "d", companyIds: [COMPANY_B] },
      ],
    });

    expect(
      accountsForAgent(config, { companyId: COMPANY_A, agentId: AGENT_CEO }).map((item) => item.key),
    ).toEqual(["rel-info", "rel-shared"]);
    expect(
      accountsForAgent(config, { companyId: COMPANY_A, agentId: AGENT_COO }).map((item) => item.key),
    ).toEqual(["rel-support", "rel-shared"]);
    expect(
      accountsForAgent(config, { companyId: COMPANY_B, agentId: AGENT_CEO }).map((item) => item.key),
    ).toEqual(["bai-info"]);
    expect(
      accountsForAgent(config, { companyId: COMPANY_B, agentId: "9e8a1c51-2fd4-4c0f-b7ba-1db573465003" }).map(
        (item) => item.key,
      ),
    ).toEqual(["bai-info"]);
  });
});
