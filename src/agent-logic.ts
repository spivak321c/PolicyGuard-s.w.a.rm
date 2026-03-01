import type { AgentIntent, IAgentDecisionEngine } from "./types";

export class ScriptedDecisionEngine implements IAgentDecisionEngine {
  async buildIntent(input: {
    agentId: string;
    marketBias: "bullish" | "bearish" | "neutral";
    protocolPreference: "raydium" | "orca" | "spl-token-swap";
  }): Promise<AgentIntent> {
    const baseAmount = input.marketBias === "bullish" ? 0.4 : input.marketBias === "bearish" ? 0.2 : 0.3;

    return {
      agentId: input.agentId,
      type: input.protocolPreference === "spl-token-swap" ? "transfer" : "swap",
      protocol: input.protocolPreference,
      amountSol: baseAmount,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: input.protocolPreference === "orca"
        ? "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k"
        : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      slippageBps: 80,
      rationale: `Scripted strategy selected ${input.protocolPreference} for ${input.marketBias} conditions.`,
      metadata: { model: "scripted-v1", confidence: 0.83 },
      timestamp: new Date()
    };
  }
}

export class OllamaStubDecisionEngine implements IAgentDecisionEngine {
  async buildIntent(input: {
    agentId: string;
    marketBias: "bullish" | "bearish" | "neutral";
    protocolPreference: "raydium" | "orca" | "spl-token-swap";
  }): Promise<AgentIntent> {
    return {
      agentId: input.agentId,
      type: input.protocolPreference === "spl-token-swap" ? "transfer" : "swap",
      protocol: input.protocolPreference,
      amountSol: 0.1,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: input.protocolPreference === "orca"
        ? "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k"
        : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      slippageBps: 50,
      rationale: `Ollama stub: ${input.protocolPreference} for ${input.marketBias} conditions.`,
      metadata: { model: "ollama-stub", deterministic: true },
      timestamp: new Date()
    };
  }
}

// Re-export all engines from one place.
export { GroqDecisionEngine } from "./ai-engines/groq-engine";
export { GenericLLMEngine } from "./ai-engines/generic-llm-engine";
export type { GenericLLMConfig } from "./ai-engines/generic-llm-engine";
export { ModelRegistry } from "./ai-engines/model-registry";
export { CoordinatorEngine } from "./ai-engines/coordinator-engine";
export type { ModelSpec } from "./ai-engines/model-registry";
export type { CoordinatorStep } from "./ai-engines/coordinator-engine";
