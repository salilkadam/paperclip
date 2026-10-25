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
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
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

  /** In-memory AWS: createSecret/createVersion store bytes; resolveVersion returns them. */
  function fakeAws(options: { corruptReadBack?: boolean } = {}) {
    const store = new Map<string, string>();
    const calls: string[] = [];
    let counter = 0;
    const prepared = (value: string, kind: string) => {
      counter += 1;
      const versionId = `aws-${counter}`;
      store.set(versionId, value);
      calls.push(`${kind}:${versionId}`);
      return {
        material: { scheme: "aws_secrets_manager_v1", secretId: "arn:aws:secretsmanager:us-east-1:1:secret:x", versionId, source: "managed" },
        valueSha256: sha(value),
        fingerprintSha256: sha(value),
        externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:x",
        providerVersionRef: versionId,
      };
    };
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockImplementation(async (input) => prepared(input.value, "create"));
    vi.spyOn(awsSecretsManagerProvider, "createVersion").mockImplementation(async (input) => prepared(input.value, "version"));
    vi.spyOn(awsSecretsManagerProvider, "resolveVersion").mockImplementation(async (input) => {
      const value = store.get(String(input.providerVersionRef));
      if (value === undefined) throw new Error("missing");
      return options.corruptReadBack ? `${value}-corrupted` : value;
    });
    const deletes = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockImplementation(async (input) => {
      calls.push(`delete:${input.mode}`);
    });
    return { store, calls, deletes };
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
    expect(aws.deletes).toHaveBeenCalledWith(expect.objectContaining({ mode: "delete" }));
    expect(await svc.getById(secret.id)).toMatchObject({ provider: "local_encrypted", latestVersion: 1 });
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

  it("a company run migrates user values first, records failures per secret, and moves a definition once all its values moved", async () => {
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
    const broken = await svc.create(companyId, { name: `b-${randomUUID()}`, provider: "local_encrypted", value: "b" });
    await db.update(companySecretVersions).set({ valueSha256: sha("tampered") }).where(eq(companySecretVersions.secretId, broken.id));
    const vault = await awsVault(companyId);
    fakeAws();

    const run = await svc.migrateCompanyProvider(companyId, { targetProviderConfigId: vault.id }, { userId: "admin" });
    expect(run.total).toBe(4);
    expect(run.counts).toEqual({ migrated: 3, failed: 1 });
    const order = run.results.map((result) => result.secretId);
    const scopes = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    const scopeOf = new Map(scopes.map((row) => [row.id, row.scope]));
    expect(order.slice(0, 2).every((id) => scopeOf.get(id) === "user")).toBe(true);
    expect(order.at(-1)).toBe(company.id); // most-rotated last
    expect(run.results.find((result) => result.secretId === broken.id)).toMatchObject({
      status: "failed", code: "secret_migration_source_mismatch",
    });
    const [movedDefinition] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, definition.id));
    expect(movedDefinition).toMatchObject({ provider: "aws_secrets_manager", providerConfigId: vault.id });
  });
});
