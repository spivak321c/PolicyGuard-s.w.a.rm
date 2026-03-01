import type { IAgentDecisionEngine } from "../types";
import { GenericLLMEngine } from "./generic-llm-engine";

export interface ModelSpec {
  name: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  temperature?: number;
}

export class ModelRegistry {
  private static readonly engines = new Map<string, IAgentDecisionEngine>();

  static register(spec: ModelSpec): void {
    const engine = new GenericLLMEngine({
      endpoint: spec.endpoint,
      model: spec.model,
      apiKey: spec.apiKey,
      temperature: spec.temperature
    });

    this.engines.set(spec.name, engine);
  }

  static registerMany(specs: ModelSpec[]): void {
    for (const spec of specs) {
      this.register(spec);
    }
  }

  static registerFromEnv(): void {
    const presets: Array<{ envKey: string; name: string; endpoint: string; modelEnv?: string }> = [
      { envKey: "GROQ_API_KEY", name: "groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", modelEnv: "GROQ_MODEL" },
      { envKey: "GEMINI_API_KEY", name: "gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", modelEnv: "GEMINI_MODEL" },
      { envKey: "OPENAI_API_KEY", name: "openai", endpoint: "https://api.openai.com/v1/chat/completions", modelEnv: "OPENAI_MODEL" },
      { envKey: "OPENROUTER_API_KEY", name: "openrouter", endpoint: "https://openrouter.ai/api/v1/chat/completions", modelEnv: "OPENROUTER_MODEL" },
      { envKey: "MISTRAL_API_KEY", name: "mistral", endpoint: "https://api.mistral.ai/v1/chat/completions", modelEnv: "MISTRAL_MODEL" },
      { envKey: "TOGETHER_API_KEY", name: "together", endpoint: "https://api.together.xyz/v1/chat/completions", modelEnv: "TOGETHER_MODEL" }
    ];

    for (const preset of presets) {
      const key = process.env[preset.envKey];
      if (!key) continue;

      const model = process.env[preset.modelEnv ?? ""] ?? process.env.LLM_MODEL;
      if (!model) continue;

      this.register({
        name: preset.name,
        endpoint: preset.endpoint,
        model,
        apiKey: key
      });
    }

    const prefix = "MODEL_";
    const suffix = "_ENDPOINT";
    const indexes = Object.keys(process.env)
      .filter((k) => k.startsWith(prefix) && k.endsWith(suffix))
      .map((k) => k.slice(prefix.length, -suffix.length))
      .filter((n) => n.length > 0);

    for (const idx of indexes) {
      const endpoint = process.env[`MODEL_${idx}_ENDPOINT`];
      const apiKey = process.env[`MODEL_${idx}_KEY`];
      const model = process.env[`MODEL_${idx}_ID`];
      if (!endpoint || !model) continue;

      this.register({
        name: idx,
        endpoint,
        model,
        apiKey
      });
    }

    if (process.env.OLLAMA_ENDPOINT && process.env.OLLAMA_MODEL) {
      this.register({
        name: "ollama",
        endpoint: process.env.OLLAMA_ENDPOINT,
        model: process.env.OLLAMA_MODEL
      });
    }

    if (process.env.LLM_ENDPOINT && process.env.LLM_MODEL) {
      this.register({
        name: "generic",
        endpoint: process.env.LLM_ENDPOINT,
        model: process.env.LLM_MODEL,
        apiKey: process.env.LLM_API_KEY
      });
    }
  }

  static get(name: string): IAgentDecisionEngine {
    const engine = this.engines.get(name);
    if (!engine) {
      const available = this.list();
      throw new Error(
        `ModelRegistry: model '${name}' is not registered. Available models: ${available.length > 0 ? available.join(", ") : "(none)"}. ` +
        "Call ModelRegistry.register(...), registerMany(...), or registerFromEnv() first."
      );
    }
    return engine;
  }

  static has(name: string): boolean {
    return this.engines.has(name);
  }

  static list(): string[] {
    return [...this.engines.keys()];
  }

  static clear(): void {
    this.engines.clear();
  }
}
