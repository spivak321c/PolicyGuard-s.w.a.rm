/**
 * GroqDecisionEngine — thin preset wrapper around GenericLLMEngine.
 * Uses Groq's OpenAI-compatible REST API directly via fetch (no SDK needed).
 *
 * Requires: GROQ_API_KEY environment variable.
 * Model:    llama-3.1-8b-instant (default) — fast, free tier.
 *
 * Other current Groq models:
 *   "llama-3.3-70b-versatile"   — most capable
 *   "llama-3.1-70b-versatile"   — large, strong reasoning
 *   "gemma2-9b-it"              — Google Gemma instruction-tuned
 *   "mixtral-8x7b-32768"        — long context window
 */

import { GenericLLMEngine } from "./generic-llm-engine";
import type { AgentIntent, IAgentDecisionEngine } from "../types";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export class GroqDecisionEngine implements IAgentDecisionEngine {
    private readonly engine: GenericLLMEngine;

    constructor(model = "llama-3.1-8b-instant") {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            throw new Error(
                "GROQ_API_KEY environment variable is required.\n" +
                "Get your free key at: https://console.groq.com"
            );
        }
        this.engine = new GenericLLMEngine({
            endpoint: GROQ_ENDPOINT,
            apiKey,
            model
        });
    }

    buildIntent(input: {
        agentId: string;
        marketBias: "bullish" | "bearish" | "neutral";
        protocolPreference: "raydium" | "orca" | "spl-token-swap";
    }): Promise<AgentIntent> {
        return this.engine.buildIntent(input);
    }
}
