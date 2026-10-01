import { createLazyStream } from "../utils/lazy-stream.js";

export { buildOpenAICompletionsParams } from "./openai-completions-params.js";

export function createOpenAICompletionsTransportStreamFn() {
  return createLazyStream(
    () => import("./openai-completions-transport.js"),
    (runtime) => runtime.createOpenAICompletionsTransportStreamFn(),
  );
}
