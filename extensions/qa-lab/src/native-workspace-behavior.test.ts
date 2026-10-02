import { describe, expect, it } from "vitest";
import {
  getQaNativeWorkspaceBehavior,
  QA_NATIVE_WORKSPACE_BEHAVIOR_IDS,
} from "./native-workspace-behavior.js";
import { buildQaToolSearchArgs } from "./providers/mock-openai/mock-openai-tooling.js";

describe("Codex-native workspace mock planning", () => {
  it.each(QA_NATIVE_WORKSPACE_BEHAVIOR_IDS)(
    "routes %s through the declared native provider tool",
    (behaviorId) => {
      const behavior = getQaNativeWorkspaceBehavior(behaviorId);
      const prompt = `tool search qa check target=${behavior.providerToolName} native-workspace-behavior=${behaviorId}`;

      expect(buildQaToolSearchArgs(behavior.providerToolName, false, prompt)).toEqual(
        behavior.happyArgs,
      );
      expect(buildQaToolSearchArgs(behavior.providerToolName, true, prompt)).toEqual(
        behavior.failureArgs,
      );
    },
  );

  it("does not change unmarked OpenClaw dynamic-tool planning", () => {
    expect(buildQaToolSearchArgs("exec", false)).toEqual({
      command: "echo runtime-tool-fixture",
      timeoutSeconds: 5,
    });
  });
});
