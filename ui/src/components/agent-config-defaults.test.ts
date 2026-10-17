import { describe, expect, it } from "vitest";
import { deploymentDefaultModel } from "./agent-config-defaults";

const STATIC_DEFAULT = "openai/gpt-5.2-codex";

describe("deploymentDefaultModel", () => {
  it("moves a blank or static-default selection to the first deployment model", () => {
    const models = [{ id: "gpuai/qwen3.8-flash-next" }, { id: "gpuai/auto" }];
    expect(deploymentDefaultModel("", STATIC_DEFAULT, models)).toBe("gpuai/qwen3.8-flash-next");
    expect(deploymentDefaultModel(STATIC_DEFAULT, STATIC_DEFAULT, models)).toBe("gpuai/qwen3.8-flash-next");
  });

  it("keeps a deliberate choice, a listed static default, or an empty list", () => {
    expect(deploymentDefaultModel("gpuai/auto", STATIC_DEFAULT, [{ id: "gpuai/qwen3.8-flash-next" }])).toBeNull();
    expect(deploymentDefaultModel(STATIC_DEFAULT, STATIC_DEFAULT, [{ id: STATIC_DEFAULT }])).toBeNull();
    expect(deploymentDefaultModel("", STATIC_DEFAULT, [])).toBeNull();
  });
});
