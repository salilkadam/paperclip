/**
 * Plugin configuration parsing and mailbox authorization.
 *
 * Two properties are load-bearing here:
 *
 * 1. Every network detail lives in `imap`, so moving the mail server to another
 *    host is a one-value config change with no code or schema change.
 * 2. Which agent may act as which mailbox is decided in code from config, never
 *    from a tool argument. An agent can only ever pick among accounts it is
 *    already allowed to use.
 */

import type { ImapTlsMode } from "./imap.js";

/** Raised for configuration problems; messages name the offending field. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Raised when an agent is not permitted to use a mailbox. */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** A secret reference as stored in config: a binding object or a pasted value. */
export type SecretRefValue =
  | string
  | { type?: string; secretId?: string; id?: string; version?: string | number }
  | null
  | undefined;

/** Where the mailbox lives. */
export interface ImapSettings {
  host: string;
  port: number;
  tlsMode: ImapTlsMode;
  serverName?: string;
  caPem?: string;
  rejectUnauthorized: boolean;
  timeoutMs: number;
  mailbox: string;
}

/** How outbound mail leaves Paperclip. */
export interface SendSettings {
  /** `ses-api` posts directly to SES; `disabled` makes the send tool refuse. */
  transport: "ses-api" | "disabled";
  sesRegion: string;
  accessKeyId: SecretRefValue;
  secretAccessKey: SecretRefValue;
  /** Optional Configuration Set for SES deliverability reporting. */
  configurationSet?: string;
}

/** One mailbox an agent may send and receive as. */
export interface MailAccount {
  /** Stable key agents pass to tools, e.g. `bionic-support`. */
  key: string;
  /** The public address humans write to, e.g. `support@reliora.ai`. */
  address: string;
  displayName?: string;
  /** IMAP login, often identical to `address`. */
  imapUser: string;
  password: SecretRefValue;
  /** Envelope and `From:` address; must be SES-verified. */
  fromAddress: string;
  replyTo: string[];
  /** Companies allowed to use this mailbox. Empty means nobody. */
  companyIds: string[];
  /** Agent allowlist. Empty means every agent in `companyIds`. */
  agentIds: string[];
}

/** Inbound polling behaviour. */
export interface PollSettings {
  enabled: boolean;
  maxMessagesPerAccount: number;
  /** Unseen messages are recorded but left unread by default. */
  markSeen: boolean;
}

/** The validated configuration. */
export interface LocAgentMailConfig {
  imap: ImapSettings;
  send: SendSettings;
  accounts: MailAccount[];
  poll: PollSettings;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EMAIL_RE = /^[^\s@"\\,]+(?:\.[^\s@"\\,]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const LOOPBACK_HOST_RE = /^(?:127\.(?:\d{1,3}\.){2}\d{1,3}|\[::1\]|::1|localhost)$/i;

function asObject(value: unknown, field: string, errors: string[]): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${field} must be an object`);
    return {};
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string, errors: string[], fallback?: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (fallback === undefined) errors.push(`${field} is required`);
    return fallback;
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return fallback;
  }
  return value.trim();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T, errors: string[]): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  errors.push(`${field} must be one of ${allowed.join(", ")}`);
  return fallback;
}

function int(value: unknown, field: string, fallback: number, min: number, max: number, errors: string[]): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${field} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

function bool(value: unknown, field: string, fallback: boolean, errors: string[]): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  errors.push(`${field} must be a boolean`);
  return fallback;
}

function strList(value: unknown, field: string, errors: string[], pattern?: RegExp, label?: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!items) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      errors.push(`${field} entries must be strings`);
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (pattern && !pattern.test(trimmed)) {
      errors.push(`${label ?? field} "${trimmed}" is not valid (${field})`);
      continue;
    }
    out.push(trimmed.toLowerCase());
  }
  return out;
}

/** Validate raw plugin config, collecting every problem before throwing. */
export function parseConfig(raw: Record<string, unknown> | undefined): LocAgentMailConfig {
  const errors: string[] = [];
  const root = asObject(raw, "config", errors);

  const imapRaw = asObject(root.imap, "imap", errors);
  const imap: ImapSettings = {
    host: str(imapRaw.host, "imap.host", errors) ?? "",
    port: int(imapRaw.port, "imap.port", 993, 1, 65535, errors),
    tlsMode: oneOf(imapRaw.tlsMode, ["implicit", "none"] as const, "imap.tlsMode", "implicit", errors),
    serverName: typeof imapRaw.serverName === "string" ? imapRaw.serverName.trim() : undefined,
    caPem: typeof imapRaw.caPem === "string" && imapRaw.caPem.trim() ? imapRaw.caPem : undefined,
    rejectUnauthorized: bool(imapRaw.rejectUnauthorized, "imap.rejectUnauthorized", true, errors),
    timeoutMs: int(imapRaw.timeoutMs, "imap.timeoutMs", 20000, 1000, 300000, errors),
    mailbox: str(imapRaw.mailbox, "imap.mailbox", errors, "INBOX") ?? "INBOX",
  };
  // `none` is offered for a same-host listener (loopback or a sidecar). Anywhere
  // else it would put the mailbox password on the wire in the clear.
  if (imap.tlsMode === "none" && !LOOPBACK_HOST_RE.test(imap.host)) {
    errors.push(
      `imap.tlsMode "none" sends the mailbox password in the clear; host "${imap.host}" is not loopback, so use tlsMode "implicit"`,
    );
  }

  const sendRaw = asObject(root.send, "send", errors);
  const send: SendSettings = {
    transport: oneOf(sendRaw.transport, ["ses-api", "disabled"] as const, "send.transport", "ses-api", errors),
    sesRegion: str(sendRaw.sesRegion, "send.sesRegion", errors, "") ?? "",
    accessKeyId: (sendRaw.accessKeyId as SecretRefValue) ?? null,
    secretAccessKey: (sendRaw.secretAccessKey as SecretRefValue) ?? null,
    configurationSet: typeof sendRaw.configurationSet === "string" ? sendRaw.configurationSet.trim() : undefined,
  };
  if (send.transport === "ses-api") {
    if (!/^[a-z0-9-]{5,20}$/.test(send.sesRegion)) errors.push("send.sesRegion must look like an AWS region, e.g. us-east-1");
    if (!send.accessKeyId) errors.push("send.accessKeyId is required when send.transport is ses-api");
    if (!send.secretAccessKey) errors.push("send.secretAccessKey is required when send.transport is ses-api");
  }

  const accountList = Array.isArray(root.accounts) ? root.accounts : [];
  if (!Array.isArray(root.accounts) && root.accounts !== undefined) errors.push("accounts must be an array");
  const accounts: MailAccount[] = [];
  const seenKeys = new Set<string>();
  const seenAddresses = new Set<string>();
  accountList.forEach((entry, index) => {
    const field = `accounts[${index}]`;
    const item = asObject(entry, field, errors);
    const key = str(item.key, `${field}.key`, errors) ?? "";
    if (key && !KEY_RE.test(key)) errors.push(`${field}.key must be a lowercase slug (letters, digits, dot, dash, underscore)`);
    if (key && seenKeys.has(key)) errors.push(`${field}.key "${key}" is duplicated`);
    seenKeys.add(key);
    const address = str(item.address, `${field}.address`, errors) ?? "";
    if (address && !EMAIL_RE.test(address)) errors.push(`${field}.address "${address}" is not a valid email address`);
    if (address && seenAddresses.has(address)) errors.push(`${field}.address "${address}" is duplicated`);
    seenAddresses.add(address);
    const fromAddress = (typeof item.fromAddress === "string" && item.fromAddress.trim()) || address;
    if (fromAddress && !EMAIL_RE.test(fromAddress)) errors.push(`${field}.fromAddress "${fromAddress}" is not a valid email address`);
    const companyIds = strList(item.companyIds, `${field}.companyIds`, errors, UUID_RE, "company id");
    const agentIds = strList(item.agentIds, `${field}.agentIds`, errors, UUID_RE, "agent id");
    if (companyIds.length === 0) {
      errors.push(`${field}.companyIds must name at least one company or no agent can use this mailbox`);
    }
    accounts.push({
      key,
      address: address.toLowerCase(),
      displayName: typeof item.displayName === "string" ? item.displayName.trim() : undefined,
      imapUser: (typeof item.imapUser === "string" && item.imapUser.trim()) || address,
      password: (item.password as SecretRefValue) ?? null,
      fromAddress: fromAddress.toLowerCase(),
      replyTo: strList(item.replyTo, `${field}.replyTo`, errors, EMAIL_RE, "reply-to address"),
      companyIds,
      agentIds,
    });
  });
  if (accounts.length === 0) errors.push("accounts must declare at least one mailbox");
  accounts.forEach((account, index) => {
    if (!account.password) errors.push(`accounts[${index}].password is required (paste it or pick a saved secret)`);
  });

  const pollRaw = asObject(root.poll, "poll", errors);
  const poll: PollSettings = {
    enabled: bool(pollRaw.enabled, "poll.enabled", true, errors),
    maxMessagesPerAccount: int(pollRaw.maxMessagesPerAccount, "poll.maxMessagesPerAccount", 25, 1, 200, errors),
    markSeen: bool(pollRaw.markSeen, "poll.markSeen", false, errors),
  };

  if (errors.length > 0) {
    throw new ConfigError(`Loc-AgentMail configuration is invalid:\n- ${Array.from(new Set(errors)).join("\n- ")}`);
  }
  return { imap, send, accounts, poll };
}

/** Look up an account by the key an agent supplied. */
export function findAccount(config: LocAgentMailConfig, key: string): MailAccount {
  const account = config.accounts.find((item) => item.key === String(key ?? "").trim().toLowerCase());
  if (!account) {
    const known = config.accounts.map((item) => item.key).join(", ");
    throw new AuthorizationError(`unknown mailbox "${key}". Configured mailboxes: ${known || "(none)"}`);
  }
  return account;
}

/**
 * Confirm an agent may act as this mailbox.
 *
 * Company membership is checked first, then the optional agent allowlist. Both
 * come from operator config, so an agent cannot widen its own reach by naming a
 * different account.
 */
export function authorizeAccount(account: MailAccount, runCtx: { companyId: string; agentId: string }): void {
  if (!account.companyIds.includes(runCtx.companyId)) {
    throw new AuthorizationError(`mailbox "${account.key}" is not available to this company`);
  }
  if (account.agentIds.length > 0 && !account.agentIds.includes(runCtx.agentId)) {
    throw new AuthorizationError(`mailbox "${account.key}" (${account.address}) is not assigned to this agent`);
  }
}

/** Accounts an agent may use, for tools that list rather than act. */
export function accountsForAgent(config: LocAgentMailConfig, runCtx: { companyId: string; agentId: string }): MailAccount[] {
  return config.accounts.filter(
    (account) =>
      account.companyIds.includes(runCtx.companyId) &&
      (account.agentIds.length === 0 || account.agentIds.includes(runCtx.agentId)),
  );
}
