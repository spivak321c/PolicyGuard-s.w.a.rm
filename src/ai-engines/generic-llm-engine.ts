/**
 * GenericLLMEngine — works with ANY OpenAI-compatible chat completions endpoint.
 *
 * Supported providers (non-exhaustive):
 *   Groq:         endpoint = "https://api.groq.com/openai/v1/chat/completions"
 *   Ollama:       endpoint = "http://localhost:11434/v1/chat/completions"
 *   Together AI:  endpoint = "https://api.together.xyz/v1/chat/completions"
 *   LM Studio:    endpoint = "http://localhost:1234/v1/chat/completions"
 *   Mistral:      endpoint = "https://api.mistral.ai/v1/chat/completions"
 *   Anthropic*:   use an OpenAI-compat proxy, or implement a subclass.
 *
 * Configuration:
 *   LLM_ENDPOINT   Full URL to the chat completions endpoint.
 *   LLM_API_KEY    Bearer token (leave empty for local Ollama / LM Studio).
 *   LLM_MODEL      Model name (e.g. "llama-3.1-8b-instant", "phi3", "mistral-small-latest").
 */

import type { AgentIntent, IAgentDecisionEngine } from "../types";
import { readFileSync } from "fs";
import { resolve } from "path";

export interface GenericLLMConfig {
    /** Full URL to the OpenAI-compatible /chat/completions endpoint. */
    endpoint: string;
    /** Bearer API key — omit or set to "" for local providers that need none. */
    apiKey?: string;
    /** Model identifier passed in the request body. */
    model: string;
    /** Temperature (0–1). Defaults to 0.3 for deterministic intent generation. */
    temperature?: number;
}

const DEVNET_SOL = "So11111111111111111111111111111111111111112";
const DEVNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const ALLOWED_PROTOCOLS = ["orca", "spl-token-swap"] as const;
const ALLOWED_TYPES = ["swap", "transfer"] as const;

const SYSTEM_PROMPT = `
You are an autonomous DeFi trading agent operating on Solana devnet.
Decide on ONE transaction intent per call.

Respond with ONLY valid JSON matching this exact schema — no commentary, no markdown:
{
  "type":        "swap" | "transfer",
  "protocol":    "orca" | "spl-token-swap",
  "amountSol":   number between 0.01 and 0.4,
  "slippageBps": integer between 10 and 100,
  "rationale":   string of at least 20 characters explaining your decision
}
Rules: use only the listed protocol and type choices. Keep amountSol ≤ 0.4.
`.trim();

/**
 * Attempt to load SKILLS.md and create a condensed skills summary for the LLM.
 * This lets the AI agent "read" the skills file and understand available capabilities.
 */
function loadSkillsContext(): string {
    try {
        const skillsPath = resolve(process.cwd(), "SKILLS.md");
        const raw = readFileSync(skillsPath, "utf-8");
        // Extract a condensed version — the LLM doesn't need the full file,
        // just enough to understand available skills and protocols.
        const lines = raw.split("\n");
        const condensed: string[] = ["\n--- SKILLS CONTEXT (from SKILLS.md) ---"];
        condensed.push("The following skills are available in this wallet system:");
        let inSkillBlock = false;
        for (const line of lines) {
            // Capture skill names and descriptions
            if (line.trim().startsWith("- name:")) {
                inSkillBlock = true;
                condensed.push(line.trim());
            } else if (inSkillBlock && line.trim().startsWith("description:")) {
                condensed.push("  " + line.trim());
                inSkillBlock = false;
            }
            // Capture section headers
            if (line.startsWith("## ")) {
                condensed.push(line);
            }
        }
        condensed.push("--- END SKILLS CONTEXT ---");
        return condensed.join("\n");
    } catch {
        return ""; // SKILLS.md not found — proceed without skills context
    }
}

const SKILLS_CONTEXT = loadSkillsContext();
if (SKILLS_CONTEXT && process.env.SWARM_TECHNICAL_LOGS === "1") {
    const skillCount = (SKILLS_CONTEXT.match(/- name:/g) || []).length;
    console.log(`  [GenericLLMEngine] Loaded SKILLS.md (${skillCount} skills injected into LLM prompt)`);
}

function safeParseIntent(
    raw: string,
    agentId: string,
    model: string,
    protocolPreference: "orca" | "spl-token-swap"
): AgentIntent {
    try {
        // Strip markdown fences if the model included them.
        const cleaned = raw.replace(/```(?:json)?/g, "").trim();
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;

        const type = ALLOWED_TYPES.includes(parsed.type as never) ? (parsed.type as AgentIntent["type"]) : "swap";
        const protocol = ALLOWED_PROTOCOLS.includes(parsed.protocol as never) ? (parsed.protocol as "orca" | "spl-token-swap") : protocolPreference;
        const amountSol = typeof parsed.amountSol === "number" && parsed.amountSol > 0 && parsed.amountSol <= 0.4 ? parsed.amountSol : 0.1;
        const slippageBps = typeof parsed.slippageBps === "number" && parsed.slippageBps > 0 && parsed.slippageBps <= 100 ? Math.floor(parsed.slippageBps) : 50;
        const rationale = typeof parsed.rationale === "string" && parsed.rationale.trim().length >= 20
            ? parsed.rationale.trim()
            : `Agent selected ${protocol} for ${agentId} on devnet.`;

        return {
            agentId,
            type,
            protocol,
            amountSol,
            inputMint: DEVNET_SOL,
            outputMint: DEVNET_USDC,
            slippageBps,
            rationale,
            metadata: { model, source: "generic-llm-engine" },
            timestamp: new Date()
        };
    } catch {
        return {
            agentId,
            type: "swap",
            protocol: protocolPreference,
            amountSol: 0.1,
            inputMint: DEVNET_SOL,
            outputMint: DEVNET_USDC,
            slippageBps: 50,
            rationale: `LLM parse fallback: safe scripted swap on ${protocolPreference} for ${agentId}.`,
            metadata: { model, source: "generic-llm-fallback" },
            timestamp: new Date()
        };
    }
}

export class GenericLLMEngine implements IAgentDecisionEngine {
    private readonly config: Required<GenericLLMConfig>;

    constructor(config: GenericLLMConfig) {
        if (!config.endpoint) {
            throw new Error("GenericLLMEngine: 'endpoint' is required.");
        }
        if (!config.model) {
            throw new Error("GenericLLMEngine: 'model' is required.");
        }
        this.config = {
            apiKey: config.apiKey ?? "",
            temperature: config.temperature ?? 0.3,
            ...config
        };
    }

    /** Convenience factory — reads from environment variables. */
    static fromEnv(): GenericLLMEngine {
        const endpoint = process.env.LLM_ENDPOINT;
        const apiKey = process.env.LLM_API_KEY ?? "";
        const model = process.env.LLM_MODEL;

        if (!endpoint) throw new Error("LLM_ENDPOINT environment variable is required.");
        if (!model) throw new Error("LLM_MODEL environment variable is required.");

        return new GenericLLMEngine({ endpoint, apiKey, model });
    }

    async buildIntent(input: {
        agentId: string;
        marketBias: "bullish" | "bearish" | "neutral";
        protocolPreference: "orca" | "spl-token-swap";
    }): Promise<AgentIntent> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json"
        };

        if (this.config.apiKey) {
            headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }

        const body = JSON.stringify({
            model: this.config.model,
            temperature: this.config.temperature,
            max_tokens: 256,
            messages: [
                { role: "system", content: SYSTEM_PROMPT + SKILLS_CONTEXT },
                {
                    role: "user",
                    content: `Agent: ${input.agentId} | Bias: ${input.marketBias} | Protocol: ${input.protocolPreference} | Time: ${new Date().toISOString()}\nReply with only the JSON intent object.`
                }
            ]
        });

        const response = await fetch(this.config.endpoint, { method: "POST", headers, body });

        if (!response.ok) {
            const text = await response.text();
            console.warn(`GenericLLMEngine API Error [${response.status}]: ${text.slice(0, 250)}...`);
            return safeParseIntent("{}", input.agentId, this.config.model, input.protocolPreference);
        }

        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const raw = data.choices?.[0]?.message?.content ?? "{}";
        return safeParseIntent(raw, input.agentId, this.config.model, input.protocolPreference);
    }
}
