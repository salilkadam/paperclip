/**
 * buildPluginWorkerEnv trust-material passthrough.
 *
 * The plugin worker environment is scrubbed by allowlist (spawned without
 * process.env), so a deployment-level NODE_EXTRA_CA_CERTS — the only way to
 * make Node trust an internal root CA, e.g. the AgentMail internal CA the
 * mail connector dials over IMAPS — never reached the worker process. Every
 * outbound TLS connection from the worker then failed with "unable to verify
 * the first certificate" while the identically-configured server process was
 * fine. NODE_EXTRA_CA_CERTS adds roots without replacing the bundled ones and
 * carries no secret material, so it forwards unconditionally — unlike the
 * credential passthroughs, which stay gated on environment-driver
 * registration.
 */
import { describe, expect, it } from "vitest";
import { buildPluginWorkerEnv } from "../services/plugin-loader.js";

const instanceInfo = { deploymentMode: "authenticated", deploymentExposure: "private" };
const plainManifest = { capabilities: [], environmentDrivers: [] };
const sandboxManifest = {
  capabilities: ["environment.drivers.register"],
  environmentDrivers: [{ driverKey: "kubernetes" }],
};

describe("buildPluginWorkerEnv NODE_EXTRA_CA_CERTS", () => {
  it("forwards NODE_EXTRA_CA_CERTS to workers without sandbox capabilities", () => {
    const env = buildPluginWorkerEnv({
      manifest: plainManifest,
      instanceInfo,
      processEnv: { NODE_EXTRA_CA_CERTS: "/ca/agentmail-ca.crt" },
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/ca/agentmail-ca.crt");
    expect(env.PAPERCLIP_DEPLOYMENT_MODE).toBe("authenticated");
  });

  it("omits the var when unset or blank", () => {
    expect(
      buildPluginWorkerEnv({ manifest: plainManifest, instanceInfo, processEnv: {} })
        .NODE_EXTRA_CA_CERTS,
    ).toBeUndefined();
    expect(
      buildPluginWorkerEnv({
        manifest: plainManifest,
        instanceInfo,
        processEnv: { NODE_EXTRA_CA_CERTS: "   " },
      }).NODE_EXTRA_CA_CERTS,
    ).toBeUndefined();
  });

  it("keeps credential passthrough gated on environment-driver registration", () => {
    const env = buildPluginWorkerEnv({
      manifest: plainManifest,
      instanceInfo,
      processEnv: {
        NODE_EXTRA_CA_CERTS: "/ca/agentmail-ca.crt",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
      },
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/ca/agentmail-ca.crt");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.KUBERNETES_SERVICE_HOST).toBeUndefined();

    const sandboxed = buildPluginWorkerEnv({
      manifest: sandboxManifest,
      packageName: "@paperclipai/plugin-kubernetes",
      packagePath: null,
      instanceInfo,
      processEnv: {
        NODE_EXTRA_CA_CERTS: "/ca/agentmail-ca.crt",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
      },
    });
    expect(sandboxed.NODE_EXTRA_CA_CERTS).toBe("/ca/agentmail-ca.crt");
    expect(sandboxed.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(sandboxed.KUBERNETES_SERVICE_HOST).toBe("10.0.0.1");
  });
});
