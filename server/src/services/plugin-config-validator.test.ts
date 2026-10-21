import { describe, expect, it } from "vitest";

import type { JsonSchema } from "@paperclipai/shared";

import { validateInstanceConfig } from "./plugin-config-validator.js";

// Mirrors the shape of shipped plugin manifests (loc-agentmail, exe-dev,
// ssh-docker): nested properties annotated with x-paperclip-group and
// x-paperclip-advanced, plus a secret-ref format field.
const annotatedSchema: JsonSchema = {
  type: "object",
  required: ["host"],
  additionalProperties: false,
  properties: {
    host: { type: "string", "x-paperclip-group": "Connection" },
    port: { type: "integer", "x-paperclip-advanced": true, "x-paperclip-group": "Connection" },
    password: { type: "string", format: "secret-ref", "x-paperclip-group": "Connection" },
  },
};

describe("validateInstanceConfig", () => {
  it("compiles schemas annotated with x-paperclip-group and x-paperclip-advanced without throwing", () => {
    expect(() =>
      validateInstanceConfig({ host: "imap.example.test", port: 993, password: "00000000-0000-0000-0000-000000000000" }, annotatedSchema),
    ).not.toThrow();
    expect(validateInstanceConfig({ host: "imap.example.test" }, annotatedSchema)).toEqual({ valid: true });
  });

  it("still reports structured errors when the config violates the schema", () => {
    const result = validateInstanceConfig({ port: 993 }, annotatedSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "/", message: expect.stringContaining("host") })]),
    );
  });

  it("still enforces declared property types on annotated properties", () => {
    const result = validateInstanceConfig({ host: "imap.example.test", port: "not-a-number" }, annotatedSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "/port" })]),
    );
  });

  it("keeps strict mode for genuinely unknown keywords (typo guard)", () => {
    const typoSchema: JsonSchema = {
      type: "object",
      properties: { name: { type: "string", minlenght: 3 } },
    };
    expect(() => validateInstanceConfig({ name: "ab" }, typoSchema)).toThrow(/unknown keyword/i);
  });
});
