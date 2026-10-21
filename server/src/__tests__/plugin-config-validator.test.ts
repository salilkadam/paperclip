/**
 * Regression tests for the plugin instance-config validator.
 *
 * The Loc-AgentMail connector shipped `x-paperclip-advanced` /
 * `x-paperclip-group` annotation keywords in its `instanceConfigSchema`
 * (supported by `ui/src/components/JsonSchemaForm.tsx`). Ajv strict mode
 * threw `unknown keyword` at compile time, which surfaced as an HTTP 500
 * from `POST /plugins/:id/config` and `/config/test` — blocking config
 * saves and "Test Connection" for the plugin. These tests pin both the
 * tolerance for the registered vendor keywords and the strict behavior
 * for everything else.
 */

import { describe, expect, it } from "vitest";
import type { JsonSchema } from "@paperclipai/shared";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

describe("validateInstanceConfig", () => {
  const schemaWithVendorKeywords = {
    type: "object",
    properties: {
      imap: {
        type: "object",
        properties: {
          host: { type: "string" },
          tlsMode: {
            type: "string",
            enum: ["implicit", "starttls"],
            "x-paperclip-advanced": true,
            "x-paperclip-group": "TLS",
          },
        },
        required: ["host"],
        additionalProperties: false,
      },
      passwordRef: {
        type: "string",
        format: "secret-ref",
        "x-paperclip-advanced": true,
      },
    },
    required: ["imap"],
    additionalProperties: false,
  } as unknown as JsonSchema;

  it("compiles schemas carrying Paperclip vendor-extension keywords", () => {
    // Before the fix this threw: strict mode: unknown keyword: "x-paperclip-group"
    expect(() =>
      validateInstanceConfig(
        { imap: { host: "mail.example.internal", tlsMode: "implicit" } },
        schemaWithVendorKeywords,
      ),
    ).not.toThrow();
  });

  it("validates config values against schemas with vendor keywords", () => {
    const valid = validateInstanceConfig(
      { imap: { host: "mail.example.internal", tlsMode: "starttls" } },
      schemaWithVendorKeywords,
    );
    expect(valid).toEqual({ valid: true });

    const invalid = validateInstanceConfig(
      { imap: { host: "mail.example.internal", tlsMode: "plaintext" } },
      schemaWithVendorKeywords,
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.errors?.[0]?.message).toContain("must be equal to one");
  });

  it("keeps strict mode for genuine schema mistakes", () => {
    const typoSchema = {
      type: "object",
      properties: {
        name: { type: "string", propertes: {} },
      },
    } as unknown as JsonSchema;
    expect(() => validateInstanceConfig({ name: "ok" }, typoSchema)).toThrow(
      /unknown keyword/,
    );
  });
});
