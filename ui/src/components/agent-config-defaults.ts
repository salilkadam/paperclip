import type { CreateConfigValues } from "@paperclipai/adapter-utils";

/**
 * The model a NEW agent should start on, given the models the server lists for
 * its adapter. When the deployment provides models centrally
 * (PAPERCLIP_ADAPTER_MODELS) the list no longer contains the built-in static
 * default, so a blank or static-default selection moves to the first listed
 * model. Returns null when the current selection should stay.
 */
export function deploymentDefaultModel(
  current: string,
  staticDefault: string,
  models: ReadonlyArray<{ id: string }>,
): string | null {
  if (models.length === 0) return null;
  if (current && current !== staticDefault) return null;
  if (models.some((model) => model.id === current)) return null;
  return models[0]!.id;
}

export const defaultCreateValues: CreateConfigValues = {
  adapterType: "claude_local",
  cwd: "",
  instructionsFilePath: "",
  promptTemplate: "",
  model: "",
  thinkingEffort: "",
  chrome: false,
  dangerouslySkipPermissions: true,
  search: false,
  fastMode: false,
  dangerouslyBypassSandbox: false,
  codexLegacySandboxBypass: undefined,
  command: "",
  args: "",
  extraArgs: "",
  envVars: "",
  envBindings: {},
  url: "",
  bootstrapPrompt: "",
  payloadTemplateJson: "",
  workspaceStrategyType: "project_primary",
  workspaceBaseRef: "",
  workspaceBranchTemplate: "",
  worktreeParentDir: "",
  runtimeServicesJson: "",
  maxTurnsPerRun: 1000,
  heartbeatEnabled: false,
  intervalSec: 300,
  // openclaw_gateway defaults
  authToken: "",
  agentId: "",
  sessionKeyStrategy: "issue",
  sessionKey: "",
  timeoutSec: undefined,
  waitTimeoutMs: undefined,
  disableDeviceAuth: undefined,
  autoPairOnFirstConnect: undefined,
  devicePrivateKeyPem: "",
  role: "",
  scopes: "",
  paperclipApiUrl: "",
  headersJson: "",
  password: "",
};
