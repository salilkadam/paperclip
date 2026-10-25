/**
 * Company default provider (PR-B of doc/plans/2026-10-24-hashicorp-vault-secret-provider.md):
 * where new secrets land when the caller does not choose, per-version provider
 * resolution, and delete fan-out across providers. AWS Secrets Manager stands in
 * for "a non-local provider" with its gateway calls mocked; the routing under
 * test is provider-agnostic.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
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
import { writeConnectionCredential } from "../services/connection-credentials.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company default secret provider", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-company-default-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    const started = await startEmbeddedPostgresTestDatabase("secrets-company-default");
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
    if (previousProvider === undefined) delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    else process.env.PAPERCLIP_SECRETS_PROVIDER = previousProvider;
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

  function awsPrepared(version: string, value = "v") {
    return {
      material: { scheme: "aws_secrets_manager_v1", secretId: "arn:aws:secretsmanager:us-east-1:1:secret:x", versionId: version, source: "managed" },
      valueSha256: `sha-${value}`,
      fingerprintSha256: `fp-${value}`,
      externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:x",
      providerVersionRef: version,
    };
  }

  async function awsCompanyDefault(companyId: string) {
    const svc = secretService(db);
    const vault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS",
      config: { region: "us-east-1", namespace: "prod" },
    });
    await svc.setCompanyDefaultProviderConfig(companyId, vault.id);
    return vault;
  }

  it("with no company default, unspecified writes use the deployment provider", async () => {
    const companyId = await seedCompany();
    const target = await secretService(db).resolveWriteTarget(companyId, {});
    expect(target).toEqual({ provider: "local_encrypted", providerConfigId: null });
  });

  it("an unspecified create lands on the company default vault and records it on the version", async () => {
    const companyId = await seedCompany();
    const vault = await awsCompanyDefault(companyId);
    const createSpy = vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue(awsPrepared("aws-1"));
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `s-${randomUUID()}`, value: "x" });
    expect(secret.provider).toBe("aws_secrets_manager");
    expect(secret.providerConfigId).toBe(vault.id);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ providerConfig: expect.objectContaining({ id: vault.id }) }));
    const [version] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
    expect(version).toMatchObject({ provider: "aws_secrets_manager", providerConfigId: vault.id });
  });

  it("an explicit provider family picks the company default only when the family matches", async () => {
    const companyId = await seedCompany();
    const vault = await awsCompanyDefault(companyId);
    const svc = secretService(db);
    expect(await svc.resolveWriteTarget(companyId, { provider: "aws_secrets_manager" }))
      .toEqual({ provider: "aws_secrets_manager", providerConfigId: vault.id });
    expect(await svc.resolveWriteTarget(companyId, { provider: "local_encrypted" }))
      .toEqual({ provider: "local_encrypted", providerConfigId: null });
  });

  it("an explicit family without the company default uses that family's default vault", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const familyDefault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS family default",
      isDefault: true,
      config: { region: "us-east-1" },
    });
    expect(await svc.resolveWriteTarget(companyId, { provider: "aws_secrets_manager" }))
      .toEqual({ provider: "aws_secrets_manager", providerConfigId: familyDefault.id });
    expect(await svc.resolveWriteTarget(companyId, {})).toEqual({ provider: "local_encrypted", providerConfigId: null });
  });

  it("an explicit provider vault wins and must belong to the company", async () => {
    const companyId = await seedCompany();
    const other = await seedCompany();
    const otherVault = await awsCompanyDefault(other);
    await expect(secretService(db).resolveWriteTarget(companyId, { providerConfigId: otherVault.id }))
      .rejects.toThrow(/same company/);
  });

  it("only a ready or warning vault can be the company default, and disabling one clears it", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const draft = await svc.createProviderConfig(companyId, {
      provider: "gcp_secret_manager",
      displayName: "GCP draft",
      config: {},
    });
    await expect(svc.setCompanyDefaultProviderConfig(companyId, draft.id)).rejects.toThrow(/ready or warning/);
    const vault = await awsCompanyDefault(companyId);
    expect((await svc.getCompanyDefaultProviderConfig(companyId))?.id).toBe(vault.id);
    await svc.disableProviderConfig(vault.id);
    expect(await svc.getCompanyDefaultProviderConfig(companyId)).toBeNull();
    expect(await svc.resolveWriteTarget(companyId, {})).toEqual({ provider: "local_encrypted", providerConfigId: null });
  });

  it("formerly hard-coded local sites follow the default: Claude OAuth definition and shared connection credentials", async () => {
    const companyId = await seedCompany();
    const vault = await awsCompanyDefault(companyId);
    const svc = secretService(db);
    const definition = await svc.ensureClaudeOAuthUserSecretDefinition(companyId);
    expect(definition).toMatchObject({ provider: "aws_secrets_manager", providerConfigId: vault.id });
    // Still recognised as the compatible fixed definition on the next call.
    expect((await svc.ensureClaudeOAuthUserSecretDefinition(companyId)).id).toBe(definition.id);

    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "user-1", status: "active", membershipRole: "owner",
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue(awsPrepared("aws-1"));
    await db.transaction(async (tx) => writeConnectionCredential(tx as never, {
      companyId,
      connectionName: "GitHub",
      configPath: "oauth.access_token",
      label: "token",
      value: "tok",
      ownerUserId: "user-1",
      definitionKey: `oauth.${randomUUID()}`,
    }));
    const definitions = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.companyId, companyId));
    expect(definitions.every((row) => row.provider === "aws_secrets_manager" && row.providerConfigId === vault.id)).toBe(true);
  });

  it("a pinned old version resolves through the provider it was written to after the secret moves", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `moving-${randomUUID()}`, provider: "local_encrypted", value: "old-local" });
    const vault = await awsCompanyDefault(companyId);
    // What PR-C's migrateProvider will do: repoint the parent, then rotate.
    await db.update(companySecrets)
      .set({ provider: "aws_secrets_manager", providerConfigId: vault.id })
      .where(eq(companySecrets.id, secret.id));
    vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue(awsPrepared("aws-2", "new"));
    const resolveAws = vi.spyOn(awsSecretsManagerProvider, "resolveVersion").mockResolvedValue("new-aws");
    const resolveLocal = vi.spyOn(localEncryptedProvider, "resolveVersion");
    await svc.rotate(secret.id, { value: "new" });

    expect(await svc.resolveSecretValue(companyId, secret.id, 1)).toBe("old-local");
    expect(resolveLocal).toHaveBeenCalledTimes(1);
    expect(resolveAws).not.toHaveBeenCalled();
    expect(await svc.resolveSecretValue(companyId, secret.id, "latest")).toBe("new-aws");
    expect(resolveAws).toHaveBeenCalledWith(expect.objectContaining({ providerConfig: expect.objectContaining({ id: vault.id }) }));

    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
    expect(versions.map((row) => [row.version, row.provider]).sort()).toEqual([[1, "local_encrypted"], [2, "aws_secrets_manager"]]);
  });

  it("deletes in every provider the secret's versions live in", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, { name: `split-${randomUUID()}`, provider: "local_encrypted", value: "a" });
    const vault = await awsCompanyDefault(companyId);
    await db.update(companySecrets)
      .set({ provider: "aws_secrets_manager", providerConfigId: vault.id })
      .where(eq(companySecrets.id, secret.id));
    vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue(awsPrepared("aws-2", "b"));
    await svc.rotate(secret.id, { value: "b" });
    const awsDelete = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    const localDelete = vi.spyOn(localEncryptedProvider, "deleteOrArchive");

    await svc.remove(secret.id);
    expect(awsDelete).toHaveBeenCalledTimes(1);
    expect(awsDelete).toHaveBeenCalledWith(expect.objectContaining({
      mode: "delete",
      material: expect.objectContaining({ versionId: "aws-2" }),
      context: expect.objectContaining({ secretId: secret.id }),
    }));
    expect(localDelete).toHaveBeenCalledTimes(1);
  });

  it("the migration backfills each existing version's provider from its parent", async () => {
    const companyId = await seedCompany();
    const vault = await awsCompanyDefault(companyId);
    const [secret] = await db.insert(companySecrets).values({
      companyId, key: "legacy", name: "legacy", provider: "aws_secrets_manager", providerConfigId: vault.id, status: "active",
      latestVersion: 1,
    }).returning();
    await db.insert(companySecretVersions).values({
      secretId: secret!.id, version: 1, material: {}, valueSha256: "x", fingerprintSha256: "x", status: "current",
    });
    const migration = readFileSync(
      path.resolve(import.meta.dirname, "../../../packages/db/src/migrations/0375_sad_captain_midlands.sql"),
      "utf8",
    );
    const backfill = migration.split("--> statement-breakpoint").find((statement) => statement.includes("UPDATE"));
    expect(backfill).toBeTruthy();
    await db.execute(sql.raw(backfill!));
    const [version] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret!.id));
    expect(version).toMatchObject({ provider: "aws_secrets_manager", providerConfigId: vault.id });
  });
});
