import { describe, expect, it } from "vitest";
import {
  createUserSecretDefinitionSchema,
  createUserSecretDeclarationSchema,
  createUserSecretValueSchema,
  createSecretProviderConfigSchema,
  createSecretSchema,
  envBindingUserSecretRefSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  rotateSecretSchema,
  rotateUserSecretValueSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  secretProviderConfigPayloadSchema,
  updateUserSecretValueSchema,
  updateUserSecretDefinitionSchema,
  updateSecretProviderConfigSchema,
} from "./secret.js";

describe("secret validators", () => {
  it("defaults user secret refs to required and no missing override", () => {
    expect(
      envBindingUserSecretRefSchema.parse({
        type: "user_secret_ref",
        key: "github_api_token",
      }),
    ).toEqual({
      type: "user_secret_ref",
      key: "github_api_token",
      required: true,
      allowMissingOverride: false,
    });
  });

  it("validates user secret declarations and current-user value payloads", () => {
    expect(
      createUserSecretDeclarationSchema.parse({
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.GITHUB_TOKEN",
        envKey: "GITHUB_TOKEN",
        definitionKey: "github_api_token",
      }),
    ).toMatchObject({
      versionSelector: "latest",
      required: true,
      allowMissingOverride: false,
    });

    expect(() =>
      createUserSecretValueSchema.parse({
        value: "secret-value",
      }),
    ).toThrow(/definitionId or definitionKey/);
  });

  it("does not allow user secret definition keys to be renamed through updates", () => {
    expect(
      updateUserSecretDefinitionSchema.parse({
        key: "renamed_key",
        name: "Renamed",
      }),
    ).toEqual({
      name: "Renamed",
    });
  });

  it("does not allow user secret definitions to be created as deleted", () => {
    expect(() =>
      createUserSecretDefinitionSchema.parse({
        key: "github_api_token",
        name: "GitHub API token",
        status: "deleted",
      }),
    ).toThrow();
  });

  it("requires secret rotation payloads to include rotation input", () => {
    expect(() => rotateSecretSchema.parse({})).toThrow(/requires value, externalRef/);
    expect(() => rotateUserSecretValueSchema.parse({})).toThrow(/requires value, externalRef/);
    expect(() => rotateUserSecretValueSchema.parse({ providerVersionRef: null })).toThrow(/requires value, externalRef/);
    expect(() => rotateUserSecretValueSchema.parse({ providerConfigId: null })).toThrow(/requires value, externalRef/);
    expect(() => rotateUserSecretValueSchema.parse({ externalRef: "" })).toThrow();
    expect(() => rotateUserSecretValueSchema.parse({ providerVersionRef: "" })).toThrow();
    expect(rotateUserSecretValueSchema.parse({ value: "new-secret" })).toEqual({
      value: "new-secret",
    });
    expect(rotateUserSecretValueSchema.parse({ providerVersionRef: "version-2" })).toEqual({
      providerVersionRef: "version-2",
    });
  });

  it("rejects empty external selectors in user secret patches", () => {
    expect(() => updateUserSecretValueSchema.parse({ externalRef: "" })).toThrow();
    expect(() => updateUserSecretValueSchema.parse({ providerVersionRef: "" })).toThrow();
    expect(updateUserSecretValueSchema.parse({ externalRef: null, providerVersionRef: null })).toEqual({
      externalRef: null,
      providerVersionRef: null,
    });
  });

  it("rejects externalRef on managed secrets", () => {
    expect(() =>
      createSecretSchema.parse({
        name: "OpenAI API Key",
        managedMode: "paperclip_managed",
        value: "secret-value",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
      }),
    ).toThrow(/Managed secrets cannot set externalRef/);
  });

  it("allows externalRef on external reference secrets", () => {
    const parsed = createSecretSchema.parse({
      name: "Shared Secret",
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
    });

    expect(parsed.externalRef).toContain(":secret:shared/other");
  });

  it("accepts non-sensitive local and AWS provider vault metadata", () => {
    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "local_encrypted",
        displayName: "Local",
        config: { backupReminderAcknowledged: true },
      }),
    ).not.toThrow();

    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "aws_secrets_manager",
        displayName: "AWS",
        config: {
          region: "us-east-1",
          namespace: "production",
          secretNamePrefix: "paperclip",
        },
      }),
    ).not.toThrow();
  });

  it("accepts a Vault provider vault that only names a namespace", () => {
    const parsed = secretProviderConfigPayloadSchema.parse({ provider: "vault", config: { namespace: "admin" } });
    expect(parsed.provider).toBe("vault");
    expect(() =>
      createSecretProviderConfigSchema.parse({ provider: "vault", displayName: "Vault", status: "ready", config: { namespace: "admin" } }),
    ).not.toThrow();
  });

  it.each([
    { address: "https://vault.example.com" },
    { address: "https://user:pass@vault.example.com" },
    { address: "https://vault.example.com?token=hvs.x" },
    { mountPath: "kv" },
    { secretPathPrefix: "other/team" },
  ])("rejects deployment-owned Vault fields per provider vault: %o", (config) => {
    // Where the server connects and writes is a deployment setting; a company
    // admin must not be able to redirect the server's Vault login.
    expect(() =>
      createSecretProviderConfigSchema.parse({ provider: "vault", displayName: "Vault", config }),
    ).toThrow(/set by the deployment|origin-only HTTP\(S\) URL/i);
    expect(() => secretProviderConfigPayloadSchema.parse({ provider: "vault", config })).toThrow(/set by the deployment/i);
  });

  it("no longer locks Vault provider vaults as coming soon; GCP stays locked", () => {
    expect(() =>
      createSecretProviderConfigSchema.parse({ provider: "vault", displayName: "Vault", status: "ready", config: {} }),
    ).not.toThrow();
    expect(() =>
      createSecretProviderConfigSchema.parse({ provider: "gcp_secret_manager", displayName: "GCP", status: "ready", config: {} }),
    ).toThrow(/locked while coming soon/i);
  });

  it("rejects unsafe Vault addresses in provider vault update payloads", () => {
    expect(() =>
      updateSecretProviderConfigSchema.parse({
        config: { address: "https://vault.example.com#token=hvs.x" },
      }),
    ).toThrow(/origin-only HTTP\(S\) URL/i);
  });

  it("validates AWS remote import preview and import payloads", () => {
    expect(
      remoteSecretImportPreviewSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        query: "openai",
        pageSize: 50,
      }),
    ).toEqual({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      query: "openai",
      pageSize: 50,
    });

    expect(
      remoteSecretImportSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "OPENAI_API_KEY",
            description: "  Operator-entered Paperclip description  ",
            providerMetadata: { name: "prod/openai" },
          },
        ],
      }),
    ).toMatchObject({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      secrets: [
        expect.objectContaining({
          key: "OPENAI_API_KEY",
          description: "Operator-entered Paperclip description",
        }),
      ],
    });
  });

  it("validates AWS provider vault discovery draft config without allowing sensitive keys", () => {
    expect(
      secretProviderConfigDiscoveryPreviewSchema.parse({
        provider: "aws_secrets_manager",
        config: {
          region: "us-east-1",
          namespace: "production",
          secretNamePrefix: "paperclip",
        },
        query: "paperclip",
        pageSize: 50,
      }),
    ).toEqual({
      provider: "aws_secrets_manager",
      config: {
        region: "us-east-1",
        namespace: "production",
        secretNamePrefix: "paperclip",
      },
      query: "paperclip",
      pageSize: 50,
    });

    expect(() =>
      secretProviderConfigDiscoveryPreviewSchema.parse({
        provider: "aws_secrets_manager",
        config: {
          region: "us-east-1",
          accessKeyId: "AKIA...",
        },
      }),
    ).toThrow(/sensitive field/i);
  });

  it("caps AWS remote import paging and row counts", () => {
    expect(() =>
      remoteSecretImportPreviewSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        pageSize: 101,
      }),
    ).toThrow();
    expect(() =>
      remoteSecretImportSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [],
      }),
    ).toThrow();
  });
});
