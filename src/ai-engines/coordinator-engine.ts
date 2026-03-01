import type { AgentIntent, IAgentDecisionEngine } from "../types";

export interface CoordinatorStep {
  model: string | IAgentDecisionEngine;
  role: string;
}

export class CoordinatorEngine implements IAgentDecisionEngine {
  private readonly resolver: (name: string) => IAgentDecisionEngine;

  constructor(
    private readonly steps: CoordinatorStep[],
    resolver?: (name: string) => IAgentDecisionEngine
  ) {
    if (steps.length < 2) {
      throw new Error("CoordinatorEngine requires at least 2 steps.");
    }

    this.resolver = resolver ?? ((name: string) => {
      // Lazy require to avoid circular dependencies at module load time.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ModelRegistry } = require("./model-registry") as { ModelRegistry: { get: (key: string) => IAgentDecisionEngine } };
      return ModelRegistry.get(name);
    });
  }

  async buildIntent(input: {
    agentId: string;
    marketBias: "bullish" | "bearish" | "neutral";
    protocolPreference: "raydium" | "orca" | "spl-token-swap";
  }): Promise<AgentIntent> {
    const rationales: string[] = [];
    const roles: string[] = [];
    let minAmountSol = Number.POSITIVE_INFINITY;
    let lastIntent: AgentIntent | undefined;

    for (let i = 0; i < this.steps.length; i += 1) {
      const step = this.steps[i]!;
      const engine = typeof step.model === "string" ? this.resolver(step.model) : step.model;

      const contextualInput = {
        ...input,
        agentId: rationales.length > 0
          ? `${input.agentId} | prior: ${rationales[rationales.length - 1]}`
          : input.agentId
      };

      try {
        const intent = await engine.buildIntent(contextualInput);
        rationales.push(intent.rationale);
        roles.push(step.role);
        minAmountSol = Math.min(minAmountSol, intent.amountSol);
        lastIntent = intent;

        console.log(
          `[coordinator:${step.role}:step-${i + 1}/${this.steps.length}] ${intent.agentId} → ${intent.protocol} ${intent.amountSol} | ${intent.rationale}`
        );
      } catch (err) {
        if (i === 0) {
          throw err;
        }

        console.warn(
          `[coordinator:${step.role}:step-${i + 1}/${this.steps.length}] failed, continuing.`,
          err
        );
      }
    }

    if (!lastIntent) {
      throw new Error("CoordinatorEngine: no successful step produced an intent.");
    }

    return {
      ...lastIntent,
      amountSol: Number.isFinite(minAmountSol) ? minAmountSol : lastIntent.amountSol,
      rationale: `[${roles.join("→")}] ${lastIntent.rationale}`,
      metadata: {
        ...(lastIntent.metadata ?? {}),
        fullRationaleChain: rationales.join(" | ")
      }
    };
  }
}
