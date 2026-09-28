import { createSetupTranslator, type SetupTranslator } from "../wizard/i18n/index.js";
import type { SystemAgentOverview } from "./overview.js";
import type { LocalCommandProbe } from "./probes.js";

function formatCommandProbe(probe: LocalCommandProbe): string {
  if (!probe.found) {
    return "not found";
  }
  if (probe.version) {
    return probe.version;
  }
  return probe.error ? `found (${probe.error})` : "found";
}

export function formatSystemAgentOverview(overview: SystemAgentOverview): string {
  const agentLines = overview.agents.map((agent) => {
    const bits = [
      agent.id,
      agent.isDefault ? "default" : undefined,
      agent.name ? `name=${agent.name}` : undefined,
      agent.model ? `model=${agent.model}` : undefined,
      agent.utilityModel ? `utility=${agent.utilityModel}` : undefined,
      agent.workspace ? `workspace=${agent.workspace}` : undefined,
    ].filter(Boolean);
    return `  - ${bits.join(" | ")}`;
  });
  const configStatus = overview.config.valid
    ? overview.config.exists
      ? "valid"
      : "missing"
    : "invalid";
  const issueLines =
    overview.config.issues.length > 0
      ? ["Config issues:", ...overview.config.issues.map((issue) => `  - ${issue}`)]
      : [];
  return [
    "OpenClaw online. Little claws, typed tools.",
    "",
    `Config: ${configStatus}`,
    `Path: ${overview.config.path}`,
    `Default agent: ${overview.defaultAgentId}`,
    `Default model: ${overview.defaultModel ?? "not configured"}`,
    ...(overview.setupModel ? [`Setup model: ${overview.setupModel}`] : []),
    ...(overview.utilityModel ? [`Utility model: ${overview.utilityModel}`] : []),
    "Agents:",
    ...agentLines,
    `Codex: ${formatCommandProbe(overview.tools.codex)}`,
    `Claude Code: ${formatCommandProbe(overview.tools.claude)}`,
    `Gemini CLI: ${formatCommandProbe(overview.tools.gemini)}`,
    `API keys: OpenAI ${overview.tools.apiKeys.openai ? "found" : "not found"}, Anthropic ${
      overview.tools.apiKeys.anthropic ? "found" : "not found"
    }`,
    `AI: ${
      overview.defaultModel || overview.setupModel
        ? `conversation runs on ${overview.defaultModel ?? overview.setupModel}`
        : "inference unavailable; run openclaw onboard before starting OpenClaw"
    }`,
    `Docs: ${overview.references.docsPath ?? overview.references.docsUrl}`,
    overview.references.sourcePath
      ? `Source: ${overview.references.sourcePath}`
      : `Source: ${overview.references.sourceUrl}`,
    `Gateway: ${overview.gateway.reachable ? "reachable" : "not reachable"} (${overview.gateway.url}, ${overview.gateway.source})`,
    overview.gateway.error ? `Gateway note: ${overview.gateway.error}` : undefined,
    `Next: ${recommendSystemAgentNextStep(overview)}`,
    ...issueLines,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function recommendSystemAgentNextStep(overview: SystemAgentOverview): string {
  if (!overview.config.exists) {
    return 'run "openclaw onboard" to establish inference';
  }
  if (!overview.config.valid) {
    return 'run "validate config" or "doctor" to inspect the config';
  }
  if (!overview.defaultModel) {
    return overview.setupModel
      ? 'continue setup here; run "openclaw onboard" to choose your regular agent model'
      : 'run "openclaw onboard" to establish inference';
  }
  if (!overview.gateway.reachable) {
    return 'run "gateway status" or "restart gateway"';
  }
  return 'run "talk to agent" to enter your default agent';
}

function formatStartupConfigStatus(overview: SystemAgentOverview): string {
  if (!overview.config.exists) {
    return "missing";
  }
  return overview.config.valid ? "valid" : "invalid";
}

function formatStartupGatewayStatus(overview: SystemAgentOverview): string {
  if (overview.gateway.reachable) {
    return `Gateway: reachable at ${overview.gateway.url}.`;
  }
  return `Gateway: not reachable at ${overview.gateway.url}; I already did the first probe.`;
}

function formatStartupAction(overview: SystemAgentOverview): string | undefined {
  if (!overview.config.valid) {
    return "Config needs attention. Run `doctor` to inspect it.";
  }
  if (!overview.defaultModel && !overview.setupModel) {
    return "Inference is unavailable. Run `openclaw onboard` and complete a live model check.";
  }
  if (!overview.defaultModel) {
    return "Setup and utility inference are ready. Choose a regular agent model in Model Setup or run `openclaw onboard`.";
  }
  return undefined;
}

/**
 * Welcome shown right after inference activation. OpenClaw owns the
 * remaining workspace, Gateway, channel, and agent setup.
 */
export function formatSystemAgentOnboardingWelcome(
  overview: SystemAgentOverview,
  translate: SetupTranslator = createSetupTranslator({ keyPrefix: "wizard.onboardingWelcome" }),
): string {
  return [
    `## ${translate("inferenceReady")}`,
    "",
    `- ${translate(overview.defaultModel ? "verifiedModel" : "verifiedSetupModel", {
      model: overview.defaultModel ?? overview.setupModel ?? translate("notConfigured"),
    })}`,
    `- ${overview.gateway.reachable ? translate("gatewayRunning", { url: overview.gateway.url }) : translate("gatewayUnavailable")}`,
    `- ${translate("optionalSetup")}`,
    `- ${translate("channelCommands")}`,
    "",
    translate(overview.defaultModel ? "readyNext" : "readySetupNext"),
  ].join("\n");
}

export function formatSystemAgentStartupMessage(overview: SystemAgentOverview): string {
  const agent = overview.agents.find((entry) => entry.id === overview.defaultAgentId);
  const agentLabel = agent?.name
    ? `${overview.defaultAgentId} (${agent.name})`
    : overview.defaultAgentId;
  return [
    "Hi, I'm OpenClaw — caretaker of this gateway, config, channels, and agents.",
    // Inference status stays independent of the recovery action line: with an
    // invalid config AND no model, both problems must be visible.
    overview.defaultModel
      ? `Model: ${overview.defaultModel}.`
      : overview.setupModel
        ? `Setup model: ${overview.setupModel}.`
        : "Inference is unavailable.",
    `Config: ${formatStartupConfigStatus(overview)}. Default agent: ${agentLabel}.`,
    formatStartupGatewayStatus(overview),
    formatStartupAction(overview),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
