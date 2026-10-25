/**
 * Integration tests for the HashiCorp Vault provider against a REAL Vault
 * (KV v2 at `secret/`). Run with scripts/test-vault-provider-integration.sh,
 * which starts hashicorp/vault, installs a policy scoped like production
 * (managed prefix read/write/soft-delete, external paths read-only, no destroy)
 * and passes a token file carrying only that policy. Skipped otherwise.
 */
import { describe, expect, it } from "vitest";
import { createVaultProvider, VaultHttpGateway, type VaultProviderConfig } from "../secrets/vault-provider.js";
import type { SecretProviderWriteContext } from "../secrets/types.js";

const addr = process.env.PAPERCLIP_TEST_VAULT_ADDR;
const tokenFile = process.env.PAPERCLIP_TEST_VAULT_TOKEN_FILE;
const run = Boolean(addr && tokenFile);

const COMPANY = "11111111-1111-4111-8111-111111111111";

function config(overrides: Partial<VaultProviderConfig> = {}): VaultProviderConfig {
  return {
    address: addr ?? "http://127.0.0.1:8200",
    namespace: null,
    mount: "secret",
    prefix: "t6-apps/bionic-org/paperclip",
    authMethod: "token_file",
    k8sRole: null,
    k8sMount: "kubernetes",
    k8sJwtPath: "/dev/null",
    tokenFile: tokenFile ?? "/dev/null",
    timeoutMs: 10_000,
    maxVersions: 100,
    externalPrefixes: ["t6-apps/bionic-org/sandbox"],
    ...overrides,
  };
}

function ctx(secretId: string, overrides: Partial<SecretProviderWriteContext> = {}): SecretProviderWriteContext {
  return { companyId: COMPANY, secretKey: "k", secretName: "n", version: 1, secretId, scope: "company", ...overrides };
}

function runtime(secretId: string) {
  return { companyId: COMPANY, secretId, secretKey: "k", version: 1 };
}

let counter = 0;
function newId() {
  counter += 1;
  return `00000000-0000-4000-8000-${String(Date.now() % 1e9).padStart(9, "0")}${String(counter).padStart(3, "0")}`;
}

describe.skipIf(!run)("vault provider against a real Vault 1.21", () => {
  it("creates, rotates and resolves exact KV versions; metadata cap is applied", async () => {
    const provider = createVaultProvider({ config: config() });
    const id = newId();
    const v1 = await provider.createSecret({ value: "first", context: ctx(id) });
    const v2 = await provider.createVersion({ value: "second", context: ctx(id, { version: 2 }), externalRef: v1.externalRef });
    expect(v1.providerVersionRef).toBe("1");
    expect(v2.providerVersionRef).toBe("2");
    expect(await provider.resolveVersion({ material: v1.material, externalRef: null, providerVersionRef: "1", context: runtime(id) })).toBe("first");
    expect(await provider.resolveVersion({ material: v2.material, externalRef: null, providerVersionRef: "2", context: runtime(id) })).toBe("second");
    const metadata = await new VaultHttpGateway(config()).readMetadata((v1.material as { path: string }).path);
    expect(metadata?.maxVersions).toBe(100);
  });

  it("rejects a stale check-and-set write with a typed conflict", async () => {
    const provider = createVaultProvider({ config: config() });
    const gateway = new VaultHttpGateway(config());
    const id = newId();
    const v1 = await provider.createSecret({ value: "one", context: ctx(id) });
    const p = (v1.material as { path: string }).path;
    await gateway.writeData(p, { value: "concurrent" }, 1); // someone else wrote version 2
    await expect(gateway.writeData(p, { value: "stale" }, 1)).rejects.toMatchObject({ code: "conflict" });
  });

  it("reports soft-deleted and pruned versions as not_found", async () => {
    const provider = createVaultProvider({ config: config({ maxVersions: 2 }) });
    const id = newId();
    const v1 = await provider.createSecret({ value: "a", context: ctx(id) });
    await provider.createVersion({ value: "b", context: ctx(id, { version: 2 }) });
    await provider.createVersion({ value: "c", context: ctx(id, { version: 3 }) }); // prunes version 1
    await expect(provider.resolveVersion({ material: v1.material, externalRef: null, providerVersionRef: "1", context: runtime(id) }))
      .rejects.toMatchObject({ code: "not_found" });
    const id2 = newId();
    const w1 = await provider.createSecret({ value: "x", context: ctx(id2) });
    await provider.deleteOrArchive({ material: w1.material, externalRef: null, mode: "archive", context: ctx(id2) });
    await expect(provider.resolveVersion({ material: w1.material, externalRef: null, providerVersionRef: "1", context: runtime(id2) }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("reads an allowed external path#field", async () => {
    const provider = createVaultProvider({ config: config() });
    const linked = await provider.linkExternalSecret({ externalRef: "t6-apps/bionic-org/sandbox#brev_ssh_private_key" });
    expect(await provider.resolveVersion({ material: linked.material, externalRef: linked.externalRef })).toBe("sandbox-key-fixture");
  });

  it("is denied outside its scope by Vault itself (policy, not just code)", async () => {
    const gateway = new VaultHttpGateway(config());
    await expect(gateway.writeData("t6-apps/bionic-org/config", { value: "x" }, null)).rejects.toMatchObject({ code: "access_denied" });
    await expect(gateway.writeData("t6-apps/bionic-org/sandbox", { value: "x" }, null)).rejects.toMatchObject({ code: "access_denied" });
    await expect(gateway.readData("t6-apps/bionic-org/config", null)).rejects.toMatchObject({ code: "access_denied" });
  });

  it("passes its health check (canary written metadata-first and read back)", async () => {
    const provider = createVaultProvider({ config: config() });
    const health = await provider.healthCheck();
    // The throwaway Vault speaks plain http on 127.0.0.1, which the provider
    // rightly warns about; anything else would be a real health problem.
    expect(health.status, health.message).not.toBe("error");
    expect(health.message).toMatch(/can write, read and cap versions/);
    expect(health.warnings ?? []).toEqual([expect.stringMatching(/plain http outside the cluster network/)]);
  });

  it("maps an unreachable Vault to provider_unavailable", async () => {
    const provider = createVaultProvider({ config: config({ address: "http://127.0.0.1:1", timeoutMs: 2_000 }) });
    await expect(provider.createSecret({ value: "x", context: ctx(newId()) })).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});
