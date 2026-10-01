import type { OpenClawConfig } from "../config/types.openclaw.js";

export function modelConfig(primary: string): OpenClawConfig {
  return { agents: { defaults: { model: { primary } }, entries: { main: { default: true } } } };
}

export function modelConfigWithApiKey(apiKey: string, agentDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      entries: { main: { default: true, agentDir } },
    },
    auth: {
      profiles: { "openai:default": { provider: "openai", mode: "api_key" } },
      order: { openai: ["openai:default"] },
    },
    models: {
      providers: {
        openai: {
          apiKey,
          baseUrl: "https://api.openai.com/v1",
          models: [],
        },
      },
    },
  };
}

export function openAiAuthProfile(apiKey: string) {
  return {
    profileId: "openai:default",
    credential: { type: "api_key" as const, provider: "openai", key: apiKey },
  };
}
