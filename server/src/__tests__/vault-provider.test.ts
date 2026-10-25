import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVaultProvider,
  managedSecretPath,
  resetVaultProviderCachesForTests,
  revokeVaultLoginForShutdown,
  VaultHttpGateway,
  type VaultKvGateway,
  type VaultProviderConfig,
} from "../secrets/vault-provider.js";
import type { SecretProviderWriteContext } from "../secrets/types.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const SECRET = "33333333-3333-4333-8333-333333333333";

beforeEach(() => resetVaultProviderCachesForTests());

function config(overrides: Partial<VaultProviderConfig> = {}): VaultProviderConfig {
  return {
    address: "http://vault.vault.svc.cluster.local:8200",
    namespace: null,
    mount: "secret",
    prefix: "t6-apps/bionic-org/paperclip",
    authMethod: "kubernetes",
    k8sRole: "bionic-org",
    k8sMount: "kubernetes",
    k8sJwtPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    tokenFile: null,
    timeoutMs: 5_000,
    maxVersions: 100,
    externalPrefixes: ["t6-apps/bionic-org/sandbox", "t6-apps/bionic-org/external/", "t6-apps/mcp/config"],
    ...overrides,
  };
}

/** In-memory KV v2 with check-and-set, metadata, soft delete. No destroy exists. */
class FakeKv implements VaultKvGateway {
  entries = new Map<string, { maxVersions: number; versions: Array<{ data: Record<string, string>; deleted: boolean }> }>();
  calls: string[] = [];

  async writeMetadata(p: string, body: { max_versions: number }) {
    this.calls.push(`metadata:${p}`);
    const entry = this.entries.get(p) ?? { maxVersions: 10, versions: [] };
    entry.maxVersions = body.max_versions;
    this.entries.set(p, entry);
  }
  async readMetadata(p: string) {
    const entry = this.entries.get(p);
    if (!entry) return null;
    const versions: Record<string, { deleted: boolean; destroyed: boolean }> = {};
    entry.versions.forEach((v, i) => { versions[String(i + 1)] = { deleted: v.deleted, destroyed: false }; });
    return { currentVersion: entry.versions.length, maxVersions: entry.maxVersions, versions };
  }
  async writeData(p: string, data: Record<string, string>, cas: number | null) {
    this.calls.push(`data:${p}:cas=${cas}`);
    const entry = this.entries.get(p) ?? { maxVersions: 10, versions: [] };
    if (cas !== null && cas !== entry.versions.length) {
      const { SecretProviderClientError } = await import("../secrets/types.js");
      throw new SecretProviderClientError({ code: "conflict", provider: "vault", operation: "writeData", message: "cas mismatch" });
    }
    entry.versions.push({ data, deleted: false });
    this.entries.set(p, entry);
    return { version: entry.versions.length };
  }
  async readData(p: string, version: number | null) {
    const entry = this.entries.get(p);
    if (!entry || entry.versions.length === 0) return null;
    const v = version ?? entry.versions.length;
    const stored = entry.versions[v - 1];
    if (!stored || stored.deleted) return null;
    return { data: stored.data, version: v };
  }
  async softDeleteVersions(p: string, versions: number[]) {
    this.calls.push(`delete:${p}:${versions.join(",")}`);
    const entry = this.entries.get(p);
    for (const v of versions) if (entry?.versions[v - 1]) entry.versions[v - 1]!.deleted = true;
  }
}

function ctx(overrides: Partial<SecretProviderWriteContext> = {}): SecretProviderWriteContext {
  return { companyId: COMPANY, secretKey: "k", secretName: "n", version: 1, secretId: SECRET, scope: "company", ...overrides };
}

describe("vault provider: paths follow ownership scope", () => {
  const cfg = config();
  it.each([
    [{ scope: "company" as const }, "company/"],
    [{ scope: "user" as const, ownerUserId: "mO44P6K9aWIwqI1BGM9v3XOvkpDwWTXy" }, "users/mO44P6K9aWIwqI1BGM9v3XOvkpDwWTXy/"],
    [{ scope: "instance" as const, ownerAgentId: "44444444-4444-4444-8444-444444444444" }, "agents/44444444-4444-4444-8444-444444444444/"],
    [{ scope: "instance" as const, ownerProjectId: "55555555-5555-4555-8555-555555555555" }, "projects/55555555-5555-4555-8555-555555555555/"],
    [{ scope: "instance" as const, ownerPluginId: "66666666-6666-4666-8666-666666666666" }, "plugins/66666666-6666-4666-8666-666666666666/"],
    // Real instance owners always name a plugin AND an agent or project: filed under the agent/project.
    [{ scope: "instance" as const, ownerPluginId: "66666666-6666-4666-8666-666666666666", ownerAgentId: "44444444-4444-4444-8444-444444444444" }, "agents/44444444-4444-4444-8444-444444444444/"],
  ])("%o", (overrides, segment) => {
    expect(managedSecretPath(cfg, ctx(overrides))).toBe(`t6-apps/bionic-org/paperclip/companies/${COMPANY}/${segment}${SECRET}`);
  });

  it("refuses to guess a path without the secret's identity", () => {
    expect(() => managedSecretPath(cfg, ctx({ secretId: undefined }))).toThrow(/valid secret id/);
    expect(() => managedSecretPath(cfg, ctx({ scope: "user", ownerUserId: null }))).toThrow(/owner user id/);
    expect(() => managedSecretPath(cfg, ctx({ scope: "instance" }))).toThrow(/owner of an instance-scoped secret/);
    expect(() => managedSecretPath(cfg, ctx({ secretId: "../escape" }))).toThrow(/valid secret id/);
  });
});

describe("vault provider: managed values", () => {
  it("writes metadata before data, caps versions, and returns self-describing material", async () => {
    const kv = new FakeKv();
    const provider = createVaultProvider({ config: config(), gateway: kv });
    const prepared = await provider.createSecret({ value: "s3cret", context: ctx() });
    const p = `t6-apps/bionic-org/paperclip/companies/${COMPANY}/company/${SECRET}`;
    expect(kv.calls).toEqual([`metadata:${p}`, `data:${p}:cas=0`]);
    expect(kv.entries.get(p)?.maxVersions).toBe(100);
    expect(prepared.material).toEqual({ scheme: "vault_kv2_v1", mount: "secret", path: p, kvVersion: 1, source: "managed" });
    expect(prepared.valueSha256).toBe(createHash("sha256").update("s3cret").digest("hex"));
    expect(prepared.providerVersionRef).toBe("1");
    expect(prepared.externalRef).toBe(`secret/${p}`);
  });

  it("rotates with check-and-set and resolves each version from its own material", async () => {
    const kv = new FakeKv();
    const provider = createVaultProvider({ config: config(), gateway: kv });
    const v1 = await provider.createSecret({ value: "one", context: ctx() });
    const v2 = await provider.createVersion({ value: "two", context: ctx({ version: 2 }), externalRef: v1.externalRef });
    expect(v2.providerVersionRef).toBe("2");
    const runtime = { companyId: COMPANY, secretId: SECRET, secretKey: "k", version: 1 };
    expect(await provider.resolveVersion({ material: v1.material, externalRef: v1.externalRef, providerVersionRef: "1", context: runtime })).toBe("one");
    expect(await provider.resolveVersion({ material: v2.material, externalRef: v2.externalRef, providerVersionRef: "2", context: runtime })).toBe("two");
  });

  it("turns a lost check-and-set race into a typed conflict, never a silent overwrite", async () => {
    const kv = new FakeKv();
    const provider = createVaultProvider({ config: config(), gateway: kv });
    await provider.createSecret({ value: "one", context: ctx() });
    const racing: VaultKvGateway = {
      ...kv,
      readMetadata: kv.readMetadata.bind(kv),
      writeMetadata: kv.writeMetadata.bind(kv),
      readData: kv.readData.bind(kv),
      softDeleteVersions: kv.softDeleteVersions.bind(kv),
      writeData: async (p, data, cas) => {
        await kv.writeData(p, { value: "concurrent" }, null); // another writer lands first
        return kv.writeData(p, data, cas);
      },
    };
    const raced = createVaultProvider({ config: config(), gateway: racing });
    await expect(raced.createVersion({ value: "two", context: ctx({ version: 2 }) })).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses material that points outside the requesting company or the managed prefix", async () => {
    const kv = new FakeKv();
    const provider = createVaultProvider({ config: config(), gateway: kv });
    const prepared = await provider.createSecret({ value: "mine", context: ctx() });
    await expect(provider.resolveVersion({
      material: prepared.material, externalRef: null, providerVersionRef: "1",
      context: { companyId: OTHER_COMPANY, secretId: SECRET, secretKey: "k", version: 1 },
    })).rejects.toThrow(/does not belong to this company/);
    await expect(provider.resolveVersion({
      material: { ...prepared.material, path: "t6-apps/bionic-org/config" }, externalRef: null, providerVersionRef: "1",
      context: { companyId: COMPANY, secretId: SECRET, secretKey: "k", version: 1 },
    })).rejects.toThrow(/outside the deployment's managed prefix/);
  });

  it("fails closed when a managed read or delete carries no company", async () => {
    const kv = new FakeKv();
    const provider = createVaultProvider({ config: config(), gateway: kv });
    const prepared = await provider.createSecret({ value: "mine", context: ctx() });
    await expect(provider.resolveVersion({ material: prepared.material, externalRef: null, providerVersionRef: "1" }))
      .rejects.toThrow(/does not belong to this company/);
    await expect(provider.deleteOrArchive({ material: prepared.material, externalRef: null, mode: "delete" }))
      .rejects.toThrow(/does not belong to this company/);
    expect(kv.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
  });

  it("reports a deleted or pruned version as not_found, never an empty value", async () => {
    const kv = new FakeKv();
    const provider = createVaultProvider({ config: config(), gateway: kv });
    const prepared = await provider.createSecret({ value: "gone", context: ctx() });
    await provider.deleteOrArchive({ material: prepared.material, externalRef: prepared.externalRef, mode: "archive", context: ctx() });
    await expect(provider.resolveVersion({
      material: prepared.material, externalRef: null, providerVersionRef: "1",
      context: { companyId: COMPANY, secretId: SECRET, secretKey: "k", version: 1 },
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("only soft-deletes: archive one version, delete all live versions", async () => {
    const kv = new FakeKv();
    const provider = createVaultProvider({ config: config(), gateway: kv });
    const v1 = await provider.createSecret({ value: "a", context: ctx() });
    await provider.createVersion({ value: "b", context: ctx({ version: 2 }) });
    await provider.deleteOrArchive({ material: v1.material, externalRef: null, mode: "delete", context: ctx() });
    const p = (v1.material as { path: string }).path;
    expect(kv.calls.filter((c) => c.startsWith("delete:"))).toEqual([`delete:${p}:1,2`]);
    expect(kv.entries.get(p)?.versions).toHaveLength(2); // history kept, only marked deleted
  });
});

describe("vault provider: external references", () => {
  const provider = createVaultProvider({ config: config(), gateway: new FakeKv() });

  it("links an allowed path#field as metadata only", async () => {
    const prepared = await provider.linkExternalSecret({ externalRef: "t6-apps/bionic-org/sandbox#brev_ssh_private_key" });
    expect(prepared.material).toMatchObject({ source: "external_reference", path: "t6-apps/bionic-org/sandbox", field: "brev_ssh_private_key", kvVersion: null });
    expect(prepared.externalRef).toBe("t6-apps/bionic-org/sandbox#brev_ssh_private_key");
  });

  it.each([
    ["t6-apps/bionic-org/paperclip/companies/x/company/y#value", /inside the Paperclip-managed Vault prefix/],
    ["t6-apps/bionic-org/config#paperclip_secrets_master_key", /not in the deployment's allowed external paths/],
    ["t6-apps/bionic-org/sandbox", /<kv path>#<field>/],
    ["t6-apps/bionic-org/sandbox/../config#x", /not a valid KV path/],
    ["t6-apps/mcp/config2#x", /not in the deployment's allowed external paths/],
    ["t6-apps/mcp/config/child#x", /not in the deployment's allowed external paths/], // no trailing slash: exact path only
    ["t6-apps/bionic-org/externalX/y#x", /not in the deployment's allowed external paths/],
    ["t6-apps/bionic-org/external#x", /not in the deployment's allowed external paths/], // subtree entry, not the node itself
  ])("rejects %s", async (ref, error) => {
    await expect(provider.linkExternalSecret({ externalRef: ref })).rejects.toThrow(error);
  });

  it("a trailing-slash entry allows its subtree", async () => {
    const prepared = await provider.linkExternalSecret({ externalRef: "t6-apps/bionic-org/external/brev/ssh#key" });
    expect(prepared.externalRef).toBe("t6-apps/bionic-org/external/brev/ssh#key");
  });

  it("re-validates on every read, so shrinking the allowlist cuts off existing links", async () => {
    const kv = new FakeKv();
    await kv.writeData("t6-apps/mcp/config", { k: "v" }, null);
    const linked = await createVaultProvider({ config: config(), gateway: kv }).linkExternalSecret({ externalRef: "t6-apps/mcp/config#k" });
    const narrowed = createVaultProvider({ config: config({ externalPrefixes: ["t6-apps/bionic-org/sandbox"] }), gateway: kv });
    await expect(narrowed.resolveVersion({ material: linked.material, externalRef: linked.externalRef })).rejects.toThrow(/not in the deployment's allowed external paths/);
  });

  it("resolves the field, and reports a missing field as not_found", async () => {
    const kv = new FakeKv();
    await kv.writeData("t6-apps/mcp/config", { apikey_ghost_bionic_key: "ghost-key" }, null);
    const p = createVaultProvider({ config: config(), gateway: kv });
    const linked = await p.linkExternalSecret({ externalRef: "t6-apps/mcp/config#apikey_ghost_bionic_key" });
    expect(await p.resolveVersion({ material: linked.material, externalRef: linked.externalRef })).toBe("ghost-key");
    const missing = await p.linkExternalSecret({ externalRef: "t6-apps/mcp/config#nope" });
    await expect(p.resolveVersion({ material: missing.material, externalRef: missing.externalRef })).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not offer external value writes", () => {
    expect(provider.descriptor().supportsExternalValueWrites).toBe(false);
    expect(provider.updateExternalSecretValue).toBeUndefined();
  });
});

describe("vault provider: per-company provider vault config", () => {
  const vaultRow = (cfg: Record<string, unknown>, status = "ready") => ({ id: "v1", provider: "vault" as const, status, config: cfg });

  it.each([{ address: "https://evil.example" }, { mountPath: "other" }, { secretPathPrefix: "elsewhere" }])(
    "rejects deployment-owned field %o at use time",
    async (cfg) => {
      const provider = createVaultProvider({ config: config(), gateway: new FakeKv() });
      await expect(provider.createSecret({ value: "x", context: ctx(), providerConfig: vaultRow(cfg) })).rejects.toThrow(/set by the deployment/);
    },
  );

  it("lets a provider vault pick only the deployment namespace or an allowed one", async () => {
    const kv = new FakeKv();
    const base = config({ namespace: "admin", allowedNamespaces: ["admin/bionic"] });
    const provider = createVaultProvider({ config: base, gateway: kv });
    await expect(provider.createSecret({ value: "x", context: ctx(), providerConfig: vaultRow({ namespace: "admin" }) })).resolves.toBeTruthy();
    await expect(provider.createSecret({ value: "x", context: ctx({ secretId: "77777777-7777-4777-8777-777777777777" }), providerConfig: vaultRow({ namespace: "admin/bionic" }) })).resolves.toBeTruthy();
    await expect(provider.createSecret({ value: "x", context: ctx(), providerConfig: vaultRow({ namespace: "root" }) })).rejects.toThrow(/not allowed by the deployment/);
    await expect(provider.createSecret({ value: "x", context: ctx(), providerConfig: vaultRow({ namespace: "admin/bionic\r\nx: y" }) })).rejects.toThrow(/not allowed by the deployment/);
  });

  it("rejects disabled or not-enabled provider vaults", async () => {
    const provider = createVaultProvider({ config: config(), gateway: new FakeKv() });
    await expect(provider.createSecret({ value: "x", context: ctx(), providerConfig: vaultRow({}, "disabled") })).rejects.toThrow(/disabled/);
  });
});

describe("vault provider: health check", () => {
  it("writes the canary once per cache window, not on every poll", async () => {
    const kv = new FakeKv();
    const provider = createVaultProvider({ config: config(), gateway: kv });
    const first = await provider.healthCheck();
    expect(first.status).toBe("ok");
    const writes = kv.calls.length;
    expect(writes).toBe(2); // metadata + data
    for (let i = 0; i < 5; i += 1) expect((await provider.healthCheck()).status).toBe("ok");
    expect(kv.calls.length).toBe(writes);
    expect([...kv.entries.keys()]).toEqual([expect.stringMatching(/^t6-apps\/bionic-org\/paperclip\/_health\/[0-9a-f]{12}$/)]);
    expect(kv.entries.values().next().value?.maxVersions).toBe(5);
  });

  it("caches a failure too, so a broken Vault is not hammered by the UI poll", async () => {
    const kv = new FakeKv();
    let attempts = 0;
    const failing: VaultKvGateway = {
      ...kv,
      readMetadata: kv.readMetadata.bind(kv),
      readData: kv.readData.bind(kv),
      writeData: kv.writeData.bind(kv),
      softDeleteVersions: kv.softDeleteVersions.bind(kv),
      writeMetadata: async () => {
        attempts += 1;
        const { SecretProviderClientError } = await import("../secrets/types.js");
        throw new SecretProviderClientError({ code: "access_denied", provider: "vault", operation: "writeMetadata", message: "denied" });
      },
    };
    const provider = createVaultProvider({ config: config(), gateway: failing });
    expect((await provider.healthCheck()).status).toBe("error");
    expect((await provider.healthCheck()).status).toBe("error");
    expect(attempts).toBe(1);
  });
});

describe("VaultHttpGateway auth", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-gw-"));
  const jwtPath = path.join(dir, "token");
  afterEach(() => vi.unstubAllGlobals());

  function respond(status: number, body: unknown) {
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }

  it("re-reads the ServiceAccount JWT on each login and re-logs in once on 403", async () => {
    const logins: string[] = [];
    let readsWithToken = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/auth/kubernetes/login")) {
        logins.push(JSON.parse(String(init.body)).jwt);
        writeFileSync(jwtPath, "jwt-ROTATED\n"); // kubelet rotates the projected token
        return respond(200, { auth: { client_token: `tok-${logins.length}`, lease_duration: 3600, renewable: true, accessor: "a" } });
      }
      const token = (init.headers as Record<string, string>)["x-vault-token"];
      readsWithToken += 1;
      if (token === "tok-1") return respond(403, { errors: ["permission denied"] });
      return respond(200, { data: { data: { value: "v" }, metadata: { version: 1 } } });
    }));
    writeFileSync(jwtPath, "jwt-A\n");
    const gw = new VaultHttpGateway(config({ address: "http://vault-a.test:8200", k8sJwtPath: jwtPath }));
    writeFileSync(jwtPath, "jwt-A\n");
    const first = await gw.readData("p", 1);
    expect(first?.data.value).toBe("v");
    expect(logins).toEqual(["jwt-A", "jwt-ROTATED"]); // 403 with tok-1 -> one fresh login with the re-read JWT
    expect(readsWithToken).toBe(2);
  });

  it("deduplicates concurrent logins", async () => {
    let loginCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/login")) {
        loginCount += 1;
        await new Promise((r) => setTimeout(r, 20));
        return respond(200, { auth: { client_token: "t", lease_duration: 3600, renewable: true } });
      }
      return respond(404, undefined);
    }));
    writeFileSync(jwtPath, "jwt-B");
    const gw = new VaultHttpGateway(config({ address: "http://vault-b.test:8200", k8sJwtPath: jwtPath }));
    await Promise.all([gw.readData("a", null), gw.readData("b", null), gw.readData("c", null)]);
    expect(loginCount).toBe(1);
  });

  it("maps a sealed or unreachable Vault to provider_unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    writeFileSync(jwtPath, "jwt-C");
    const gw = new VaultHttpGateway(config({ address: "http://vault-c.test:8200", k8sJwtPath: jwtPath }));
    await expect(gw.readData("p", null)).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("does not mint a token per call when a policy gap returns 403 every time", async () => {
    let logins = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/login")) {
        logins += 1;
        return respond(200, { auth: { client_token: `t${logins}`, lease_duration: 3600, renewable: true } });
      }
      return respond(403, { errors: ["permission denied"] });
    }));
    writeFileSync(jwtPath, "jwt-D");
    const gw = new VaultHttpGateway(config({ address: "http://vault-d.test:8200", k8sJwtPath: jwtPath }));
    for (let i = 0; i < 10; i += 1) await expect(gw.readData("p", null)).rejects.toMatchObject({ code: "access_denied" });
    expect(logins).toBe(2); // the initial login + one forced re-login in the window
  });

  it("re-reads a rotated token file once on 403 (token_file mode)", async () => {
    const tokenPath = path.join(dir, "vault-token");
    writeFileSync(tokenPath, "old-token\n");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>)["x-vault-token"];
      if (token === "old-token") {
        writeFileSync(tokenPath, "new-token\n"); // Vault Agent rewrote the sink
        return respond(403, { errors: ["permission denied"] });
      }
      return respond(200, { data: { data: { value: "ok" }, metadata: { version: 1 } } });
    }));
    const gw = new VaultHttpGateway(config({ address: "http://vault-e.test:8200", authMethod: "token_file", tokenFile: tokenPath }));
    expect((await gw.readData("p", 1))?.data.value).toBe("ok");
  });

  it("revokes every cached login at shutdown, including allowed namespaces", async () => {
    const revoked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      if (url.endsWith("/login")) {
        return respond(200, { auth: { client_token: `tok-${headers["x-vault-namespace"] ?? "root"}`, lease_duration: 3600, renewable: true } });
      }
      if (url.endsWith("/revoke-self")) {
        revoked.push(headers["x-vault-token"]!);
        return respond(204, undefined);
      }
      return respond(404, undefined);
    }));
    writeFileSync(jwtPath, "jwt-F");
    await new VaultHttpGateway(config({ address: "http://vault-f.test:8200", k8sJwtPath: jwtPath })).readData("p", null);
    await new VaultHttpGateway(config({ address: "http://vault-f.test:8200", k8sJwtPath: jwtPath, namespace: "admin/bionic" })).readData("p", null);
    const outcome = await revokeVaultLoginForShutdown();
    expect(outcome).toBe("revoked");
    expect(revoked.sort()).toEqual(["tok-admin/bionic", "tok-root"]);
    expect(await revokeVaultLoginForShutdown()).toBe("none");
  });

  it("cleans up", () => rmSync(dir, { recursive: true, force: true }));
});
