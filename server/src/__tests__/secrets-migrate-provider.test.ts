/**
 * Cross-provider migration (PR-C of doc/plans/2026-10-24-hashicorp-vault-secret-provider.md).
 * AWS Secrets Manager stands in for "another provider": its gateway is replaced by
 * an in-memory store, so agreement checks compare real bytes.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { awsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";
import { createVaultProvider, vaultProvider, type VaultKvGateway } from "../secrets/vault-provider.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describeEmbeddedPostgres("secret provider migration", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-migrate-provider-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secrets-migrate-provider");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(userSecretDeclarations);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    return companyId;
  }

  /**
   * In-memory AWS: createSecret/createVersion store bytes; resolveVersion returns
   * them. Like the real service, entries are named from the secret KEY (so two
   * secrets with one key share a name), an entry persists: createSecret on an
   * existing name is a conflict, createVersion on a missing one is not_found,
   * and "delete" does not free the name.
   */
  function fakeAws(options: { corruptReadBack?: boolean; corruptReadBackTimes?: number } = {}) {
    const store = new Map<string, string>();
    const calls: string[] = [];
    const names = new Set<string>();
    const nameOf = (input: { context?: { secretKey: string } }) => `paperclip/dep/${input.context?.secretKey ?? "?"}`;
    let corruptionsLeft = options.corruptReadBackTimes ?? (options.corruptReadBack ? Number.POSITIVE_INFINITY : 0);
    let counter = 0;
    const awsError = (code: "conflict" | "not_found", operation: string) =>
      new SecretProviderClientError({ code, provider: "aws_secrets_manager", operation, message: code });
    const prepared = (value: string, kind: string, name: string) => {
      counter += 1;
      const versionId = `aws-${counter}`;
      store.set(versionId, value);
      calls.push(`${kind}:${versionId}`);
      return {
        material: { scheme: "aws_secrets_manager_v1", secretId: `arn:aws:secretsmanager:us-east-1:1:secret:${name}`, versionId, source: "managed" },
        valueSha256: sha(value),
        fingerprintSha256: sha(value),
        externalRef: `arn:aws:secretsmanager:us-east-1:1:secret:${name}`,
        providerVersionRef: versionId,
      };
    };
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockImplementation(async (input) => {
      const name = nameOf(input);
      if (names.has(name)) throw awsError("conflict", "createSecret");
      names.add(name);
      return prepared(input.value, "create", name);
    });
    vi.spyOn(awsSecretsManagerProvider, "createVersion").mockImplementation(async (input) => {
      const name = nameOf(input);
      if (!names.has(name)) throw awsError("not_found", "createVersion");
      return prepared(input.value, "version", name);
    });
    vi.spyOn(awsSecretsManagerProvider, "resolveVersion").mockImplementation(async (input) => {
      const value = store.get(String(input.providerVersionRef));
      if (value === undefined) throw new Error("missing");
      if (corruptionsLeft > 0) {
        corruptionsLeft -= 1;
        return `${value}-corrupted`;
      }
      return value;
    });
    const deletes = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockImplementation(async (input) => {
      calls.push(`delete:${input.mode}`);
    });
    return { store, calls, deletes, names };
  }

  async function awsVault(companyId: string) {
    return secretService(db).createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS",
      config: { region: "us-east-1" },
    });
  }

  it("moves the current value to the target as a new version; old versions keep resolving where they were", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `m-${randomUUID()}`, provider: "local_encrypted", value: "one" });
    await svc.rotate(secret.id, { value: "two" });
    const vault = await awsVault(companyId);
    const aws = fakeAws();

    const result = await svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id }, { userId: "admin" });
    expect(result).toMatchObject({ status: "migrated", fromProvider: "local_encrypted", toProvider: "aws_secrets_manager", fromVersion: 2, toVersion: 3 });
    expect([...aws.store.values()]).toEqual(["two"]);

    const parent = await svc.getById(secret.id);
    expect(parent).toMatchObject({ provider: "aws_secrets_manager", providerConfigId: vault.id, latestVersion: 3 });
    expect(await svc.resolveSecretValue(companyId, secret.id, "latest")).toBe("two");
    expect(await svc.resolveSecretValue(companyId, secret.id, 1)).toBe("one"); // still local
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
    expect(versions.filter((row) => row.status === "current").map((row) => row.version)).toEqual([3]);

    // Idempotent: a second run is a no-op.
    expect((await svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id })).status).toBe("already_on_target");
  });

  it("rolls back to local and forward again, reusing each provider's existing entry", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `rt-${randomUUID()}`, provider: "local_encrypted", value: "v" });
    const vault = await awsVault(companyId);
    const aws = fakeAws();
    await svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id });
    const back = await svc.migrateProvider(secret.id, { targetProvider: "local_encrypted" });
    expect(back).toMatchObject({ status: "migrated", toProvider: "local_encrypted", toProviderConfigId: null, toVersion: 3 });
    expect(await svc.resolveSecretValue(companyId, secret.id, "latest")).toBe("v");
    await svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id });
    expect(aws.calls.filter((call) => !call.startsWith("delete"))).toEqual(["create:aws-1", "version:aws-2"]);
  });

  it("refuses to commit when the target reads back a different value, and removes the target write", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `rb-${randomUUID()}`, provider: "local_encrypted", value: "v" });
    const vault = await awsVault(companyId);
    const aws = fakeAws({ corruptReadBack: true });
    await expect(svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id }))
      .rejects.toMatchObject({ status: 422, details: expect.objectContaining({ code: "secret_migration_readback_mismatch" }) });
    expect(aws.deletes).toHaveBeenCalledWith(expect.objectContaining({ mode: "archive" }));
    expect(await svc.getById(secret.id)).toMatchObject({ provider: "local_encrypted", latestVersion: 1 });
  });

  /** The real Vault provider over an in-memory KV v2 with vendor check-and-set rules. */
  function fakeVault() {
    const entries = new Map<string, { versions: Array<{ data: Record<string, string>; deleted: boolean }> }>();
    const gateway: VaultKvGateway = {
      async writeMetadata(p) { if (!entries.has(p)) entries.set(p, { versions: [] }); },
      async readMetadata(p) {
        const entry = entries.get(p);
        if (!entry) return null;
        const versions: Record<string, { deleted: boolean; destroyed: boolean }> = {};
        entry.versions.forEach((v, i) => { versions[String(i + 1)] = { deleted: v.deleted, destroyed: false }; });
        return { currentVersion: entry.versions.length, maxVersions: 100, versions };
      },
      async writeData(p, data, cas) {
        const entry = entries.get(p) ?? { versions: [] };
        // Vendor rule: cas must equal the current version (0 only for a key with no versions).
        if (cas !== null && cas !== entry.versions.length) {
          throw new SecretProviderClientError({ code: "conflict", provider: "vault", operation: "writeData", message: "check-and-set parameter did not match the current version" });
        }
        entry.versions.push({ data, deleted: false });
        entries.set(p, entry);
        return { version: entry.versions.length };
      },
      async readData(p, version) {
        const stored = entries.get(p)?.versions[(version ?? entries.get(p)!.versions.length) - 1];
        return stored && !stored.deleted ? { data: stored.data, version: version ?? 0 } : null;
      },
      async softDeleteVersions(p, versions) {
        for (const v of versions) { const row = entries.get(p)?.versions[v - 1]; if (row) row.deleted = true; }
      },
    };
    const real = createVaultProvider({
      config: {
        address: "http://vault.vault.svc:8200", namespace: null, mount: "secret", prefix: "t6-apps/bionic-org/paperclip",
        authMethod: "token_file", k8sRole: null, k8sMount: "kubernetes", k8sJwtPath: "/dev/null", tokenFile: "/dev/null",
        timeoutMs: 1000, maxVersions: 100, externalPrefixes: [],
      },
      gateway,
    });
    let corruptNext = 0;
    for (const method of ["createSecret", "createVersion", "deleteOrArchive", "healthCheck", "validateConfig"] as const) {
      vi.spyOn(vaultProvider, method).mockImplementation(((...args: unknown[]) => (real[method] as (...a: unknown[]) => unknown)(...args)) as never);
    }
    vi.spyOn(vaultProvider, "resolveVersion").mockImplementation(async (input) => {
      const value = await real.resolveVersion(input);
      if (corruptNext > 0) { corruptNext -= 1; return `${value}-corrupted`; }
      return value;
    });
    return { entries, corruptOnce: () => { corruptNext = 1; } };
  }

  it("a rolled-back migration to Vault can be re-run: the leftover entry (same secret id) gets a new version", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `retry-${randomUUID()}`, provider: "local_encrypted", value: "v" });
    const vault = await svc.createProviderConfig(companyId, { provider: "vault", displayName: "Vault", config: {} });
    const kv = fakeVault();
    kv.corruptOnce();
    await expect(svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id })).rejects.toMatchObject({ status: 422 });
    const [path] = [...kv.entries.keys()];
    expect(kv.entries.get(path!)?.versions.map((v) => v.deleted)).toEqual([true]); // archived, entry kept
    expect(await svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id })).toMatchObject({ status: "migrated", toVersion: 2 });
    expect(kv.entries.get(path!)?.versions.map((v) => v.deleted)).toEqual([true, false]);
    expect(await svc.resolveSecretValue(companyId, secret.id, "latest")).toBe("v");
  });

  it("never merges two secrets that share a key into one AWS entry", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "a", role: "engineer", adapterType: "codex_local", adapterConfig: {}, status: "idle" });
    const company = await svc.create(companyId, { name: "api_token", key: "api_token", provider: "local_encrypted", value: "company-value" });
    const local = await localEncryptedProvider.createSecret({ value: "instance-value", externalRef: null });
    const [instance] = await db.insert(companySecrets).values({
      companyId, scope: "instance", ownerAgentId: agentId, key: "api_token", name: "api_token (agent)", provider: "local_encrypted",
      status: "active", latestVersion: 1,
    }).returning();
    await db.insert(companySecretVersions).values({
      secretId: instance!.id, version: 1, material: local.material, valueSha256: local.valueSha256,
      fingerprintSha256: local.fingerprintSha256 ?? local.valueSha256, provider: "local_encrypted", status: "current",
    });
    const vault = await awsVault(companyId);
    fakeAws();
    expect((await svc.migrateProvider(company.id, { targetProviderConfigId: vault.id })).status).toBe("migrated");
    await expect(svc.migrateProvider(instance!.id, { targetProviderConfigId: vault.id }))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "secret_migration_target_entry_exists" }) });
    expect(await svc.getById(instance!.id)).toMatchObject({ provider: "local_encrypted", latestVersion: 1 });
  });

  it("re-creates the target entry if an operator removed it although rows still point at it", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `gone-${randomUUID()}`, provider: "local_encrypted", value: "v" });
    const vault = await awsVault(companyId);
    const aws = fakeAws();
    await svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id });
    await svc.migrateProvider(secret.id, { targetProvider: "local_encrypted" });
    aws.names.clear(); // removed out of band
    expect(await svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id })).toMatchObject({ status: "migrated" });
    expect(aws.calls.filter((call) => !call.startsWith("delete"))).toEqual(["create:aws-1", "create:aws-2"]);
  });

  it("a write that lands during the migration wins: 409, the migration's target write is removed, nothing reverts", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `cas-${randomUUID()}`, provider: "local_encrypted", value: "old" });
    const vault = await awsVault(companyId);
    const aws = fakeAws();
    const fakeCreate = vi.mocked(awsSecretsManagerProvider.createSecret).getMockImplementation()!;
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockImplementation(async (input) => {
      // Another process (e.g. an unguarded OAuth refresh) commits version 2
      // while the migration is between its read and its commit.
      const fresh = await localEncryptedProvider.createSecret({ value: "refreshed", externalRef: null });
      await db.insert(companySecretVersions).values({
        secretId: secret.id, version: 2, material: fresh.material, valueSha256: fresh.valueSha256,
        fingerprintSha256: fresh.fingerprintSha256 ?? fresh.valueSha256, provider: "local_encrypted", status: "current",
      });
      await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, secret.id));
      return fakeCreate(input);
    });
    await expect(svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id })).rejects.toMatchObject({ status: 409 });
    expect(aws.deletes).toHaveBeenCalledTimes(1);
    expect(await svc.getById(secret.id)).toMatchObject({ provider: "local_encrypted", latestVersion: 2 });
    expect(await svc.resolveSecretValue(companyId, secret.id, "latest")).toBe("refreshed");
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
    expect(versions.map((row) => row.version).sort()).toEqual([1, 2]);
  });

  it("refuses a source whose value no longer matches its recorded digest", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `sm-${randomUUID()}`, provider: "local_encrypted", value: "v" });
    await db.update(companySecretVersions).set({ valueSha256: sha("something else") }).where(eq(companySecretVersions.secretId, secret.id));
    const vault = await awsVault(companyId);
    const aws = fakeAws();
    await expect(svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id }))
      .rejects.toMatchObject({ details: expect.objectContaining({ code: "secret_migration_source_mismatch" }) });
    expect(aws.calls).toEqual([]);
  });

  it("a dry run verifies the source and writes nothing; external references are refused", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `dr-${randomUUID()}`, provider: "local_encrypted", value: "v" });
    const vault = await awsVault(companyId);
    const aws = fakeAws();
    expect(await svc.migrateProvider(secret.id, { targetProviderConfigId: vault.id, dryRun: true }))
      .toMatchObject({ status: "dry_run", toProvider: "aws_secrets_manager", toVersion: 2 });
    expect(aws.calls).toEqual([]);
    expect(await svc.getById(secret.id)).toMatchObject({ provider: "local_encrypted", latestVersion: 1 });

    const [external] = await db.insert(companySecrets).values({
      companyId, key: "ext", name: "ext", provider: "aws_secrets_manager", providerConfigId: vault.id,
      managedMode: "external_reference", externalRef: "arn:x", status: "active", latestVersion: 1,
    }).returning();
    await expect(svc.migrateProvider(external!.id, { targetProvider: "local_encrypted" }))
      .rejects.toMatchObject({ details: expect.objectContaining({ code: "secret_external_reference" }) });
  });

  it("a company dry run reports definitions as would-move, not failed; a --secret run skips the definitions pass", async () => {
    const companyId = await seedCompany();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "user-1", status: "active", membershipRole: "owner" });
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, { key: "dd", name: "Dry", provider: "local_encrypted" });
    const value = await svc.createCurrentUserSecretValue(companyId, "user-1", { definitionId: definition.id, value: "x" });
    const vault = await awsVault(companyId);
    const aws = fakeAws();
    const dry = await svc.migrateCompanyProvider(companyId, { targetProviderConfigId: vault.id, dryRun: true });
    expect(dry.counts).toEqual({ dry_run: 2 });
    expect(aws.calls).toEqual([]);
    const [still] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, definition.id));
    expect(still).toMatchObject({ provider: "local_encrypted" });

    const other = await svc.createUserSecretDefinition(companyId, { key: "untouched", name: "Untouched", provider: "local_encrypted" });
    const subset = await svc.migrateCompanyProvider(companyId, { targetProviderConfigId: vault.id, secretIds: [value.id] });
    expect(subset.results.some((result) => result.kind === "definition")).toBe(false);
    const [untouched] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, other.id));
    expect(untouched).toMatchObject({ provider: "local_encrypted" });
  });

  it("a definition with an active value left behind is reported, not moved", async () => {
    const companyId = await seedCompany();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "user-1", status: "active", membershipRole: "owner" });
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, { key: "pend", name: "Pending", provider: "local_encrypted" });
    const value = await svc.createCurrentUserSecretValue(companyId, "user-1", { definitionId: definition.id, value: "x" });
    await db.update(companySecretVersions).set({ valueSha256: sha("tampered") }).where(eq(companySecretVersions.secretId, value.id));
    const vault = await awsVault(companyId);
    fakeAws();
    const run = await svc.migrateCompanyProvider(companyId, { targetProviderConfigId: vault.id });
    expect(run.results.find((result) => result.secretId === definition.id)).toMatchObject({
      kind: "definition", status: "failed", code: "definition_values_pending",
    });
    const [still] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, definition.id));
    expect(still).toMatchObject({ provider: "local_encrypted" });
  });

  it("migrating a definition's last active value moves the definition even with an archived sibling", async () => {
    const companyId = await seedCompany();
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "user-1", status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: "user-2", status: "active", membershipRole: "member" },
    ]);
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, { key: "tok", name: "Token", provider: "local_encrypted" });
    const live = await svc.createCurrentUserSecretValue(companyId, "user-1", { definitionId: definition.id, value: "live" });
    const archived = await svc.createCurrentUserSecretValue(companyId, "user-2", { definitionId: definition.id, value: "old" });
    await db.update(companySecrets).set({ status: "archived" }).where(eq(companySecrets.id, archived.id));
    const vault = await awsVault(companyId);
    fakeAws();
    await svc.migrateProvider(live.id, { targetProviderConfigId: vault.id });
    const [moved] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, definition.id));
    expect(moved).toMatchObject({ provider: "aws_secrets_manager", providerConfigId: vault.id });
  });

  it("a company run migrates user values first, records failures per secret, and moves a definition once all its values moved", { timeout: 60_000 }, async () => {
    const companyId = await seedCompany();
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "user-1", status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: "user-2", status: "active", membershipRole: "member" },
    ]);
    const svc = secretService(db);
    const company = await svc.create(companyId, { name: `c-${randomUUID()}`, provider: "local_encrypted", value: "c" });
    await svc.rotate(company.id, { value: "c2" });
    const definition = await svc.createUserSecretDefinition(companyId, { key: "gh", name: "GitHub", provider: "local_encrypted" });
    await svc.createCurrentUserSecretValue(companyId, "user-1", { definitionId: definition.id, value: "u1" });
    await svc.createCurrentUserSecretValue(companyId, "user-2", { definitionId: definition.id, value: "u2" });
    const emptyDefinition = await svc.createUserSecretDefinition(companyId, { key: "empty", name: "No values yet", provider: "local_encrypted" });
    const pinnedDefinition = await svc.createUserSecretDefinition(companyId, { key: "pinned", name: "Archived value", provider: "local_encrypted" });
    const archivedValue = await svc.createCurrentUserSecretValue(companyId, "user-1", { definitionId: pinnedDefinition.id, value: "old" });
    await db.update(companySecrets).set({ status: "archived" }).where(eq(companySecrets.id, (archivedValue as { id: string }).id));
    const broken = await svc.create(companyId, { name: `b-${randomUUID()}`, provider: "local_encrypted", value: "b" });
    await db.update(companySecretVersions).set({ valueSha256: sha("tampered") }).where(eq(companySecretVersions.secretId, broken.id));
    const vault = await awsVault(companyId);
    fakeAws();

    // One of two user values moved: the definition stays where it was.
    const [firstUserValue] = await db.select().from(companySecrets).where(eq(companySecrets.ownerUserId, "user-1"));
    await svc.migrateProvider(firstUserValue!.id, { targetProviderConfigId: vault.id });
    const [partial] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, definition.id));
    expect(partial).toMatchObject({ provider: "local_encrypted", providerConfigId: null });

    const run = await svc.migrateCompanyProvider(companyId, { targetProviderConfigId: vault.id }, { userId: "admin" });
    // Secrets: user-1 already moved, user-2 + company migrated, broken failed;
    // definitions: the empty and the archived-value one migrated ("gh" moved with user-2).
    expect(run.counts).toEqual({ already_on_target: 1, migrated: 4, failed: 1 });
    expect(run.results.filter((result) => result.kind === "definition").map((result) => result.status).sort())
      .toEqual(["migrated", "migrated"]);
    const order = run.results.filter((result) => result.kind !== "definition").map((result) => result.secretId);
    const scopes = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    const scopeOf = new Map(scopes.map((row) => [row.id, row.scope]));
    expect(order.slice(0, 2).every((id) => scopeOf.get(id) === "user")).toBe(true);
    expect(order.at(-1)).toBe(company.id); // most-rotated last
    expect(run.results.find((result) => result.secretId === broken.id)).toMatchObject({
      status: "failed", code: "secret_migration_source_mismatch",
    });
    const [movedDefinition] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, definition.id));
    expect(movedDefinition).toMatchObject({ provider: "aws_secrets_manager", providerConfigId: vault.id });
    expect(run.results.find((result) => result.secretId === emptyDefinition.id)).toMatchObject({ kind: "definition", status: "migrated" });
    const [movedEmpty] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, emptyDefinition.id));
    expect(movedEmpty).toMatchObject({ provider: "aws_secrets_manager", providerConfigId: vault.id });
    // An archived value does not pin its definition.
    const [movedPinned] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, pinnedDefinition.id));
    expect(movedPinned).toMatchObject({ provider: "aws_secrets_manager" });
  });
});
