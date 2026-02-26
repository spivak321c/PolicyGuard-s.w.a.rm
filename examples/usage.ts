#!/usr/bin/env bun
/**
 * examples/usage.ts — Shows all three engine modes.
 *
 * Run (scripted only, no keys needed):
 *   bun run example
 *
 * Run with Groq:
 *   GROQ_API_KEY=gsk_... bun run example
 *
 * Run with local Ollama:
 *   LLM_ENDPOINT=http://localhost:11434/v1/chat/completions \
 *   LLM_MODEL=phi3 bun run example
 *
 * Run with Together AI / Mistral / any OpenAI-compat provider:
 *   LLM_ENDPOINT=https://api.together.xyz/v1/chat/completions \
 *   LLM_API_KEY=your_key LLM_MODEL=llama-3.1-8b-instant \
 *   bun run example
 */

import { Keypair } from "@solana/web3.js";
import {
  ScriptedDecisionEngine,
  GroqDecisionEngine,
  GenericLLMEngine
} from "../src/agent-logic";
import { SwarmExecutor } from "../src/swarm-executor";
import type { IAgentDecisionEngine } from "../src/types";

const hr = () => console.log("\n" + "─".repeat(60));

function attachLogs(swarm: SwarmExecutor): void {
  swarm.events.on("intent.created", (e) => {
    const i = e.payload.intent as { protocol: string; amountSol: number };
    console.log(`  [${e.agentId}] 📋 ${i.protocol} ${i.amountSol}◎`);
  });
  swarm.events.on("intent.executed", (e) =>
    console.log(`  [${e.agentId}] ✅ sig: ${e.payload.sig as string}`)
  );
  swarm.events.on("intent.rejected", (e) => {
    const err = e.payload.error;
    console.log(`  [${e.agentId}] ❌ ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function runSwarm(label: string, engine: IAgentDecisionEngine): Promise<void> {
  hr();
  console.log(`  ${label}`);
  hr();
  const swarm = new SwarmExecutor(undefined, engine);
  swarm.spawnAgents(6);
  attachLogs(swarm);
  try {
    const results = await swarm.runCoordinatedYieldStrategy();
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const bad = results.filter((r) => r.status === "rejected").length;
    console.log(`  → ${ok} executed, ${bad} rejected`);
  } catch (err) {
    console.log("  Swarm error:", err instanceof Error ? err.message : err);
  }
}

// ── 1. Scripted (always runs) ─────────────────────────────────────────────────

hr();
console.log("  DEMO WALLET");
const wallet = Keypair.generate();
console.log("  Public key:", wallet.publicKey.toBase58());
console.log("  (Fund with: solana airdrop 2 <pubkey> --url devnet)");

const scripted = new ScriptedDecisionEngine();
const sampleIntent = await scripted.buildIntent({
  agentId: "demo", marketBias: "bullish", protocolPreference: "jupiter"
});
console.log("\n  Sample intent (scripted):");
console.log("   protocol   :", sampleIntent.protocol);
console.log("   amountSol  :", sampleIntent.amountSol);
console.log("   slippageBps:", sampleIntent.slippageBps);
console.log("   rationale  :", sampleIntent.rationale);

await runSwarm("1. Scripted Engine (no API key)", scripted);

// ── 2. Groq (if GROQ_API_KEY is set) ─────────────────────────────────────────

if (process.env.GROQ_API_KEY) {
  const model = process.env.GROQ_MODEL ?? "llama-3.1-8b-instant";
  const engine = new GroqDecisionEngine(model);

  hr();
  console.log(`  2. Groq Engine (${model})`);
  const intent = await engine.buildIntent({ agentId: "groq-demo", marketBias: "neutral", protocolPreference: "jupiter" });
  console.log("  LLM-generated intent:");
  console.log("   protocol   :", intent.protocol);
  console.log("   amountSol  :", intent.amountSol);
  console.log("   slippageBps:", intent.slippageBps);
  console.log("   rationale  :", intent.rationale);

  await runSwarm(`2. Groq Swarm (${model}, 6 agents)`, engine);
} else {
  hr();
  console.log("  2. Groq — SKIPPED");
  console.log("  Set GROQ_API_KEY to enable. Free key at: https://console.groq.com");
}

// ── 3. Generic LLM (if LLM_ENDPOINT + LLM_MODEL are set) ────────────────────

if (process.env.LLM_ENDPOINT && process.env.LLM_MODEL) {
  const engine = GenericLLMEngine.fromEnv();
  const model = process.env.LLM_MODEL;

  hr();
  console.log(`  3. Generic LLM Engine (${model})`);
  console.log("  Endpoint:", process.env.LLM_ENDPOINT);

  const intent = await engine.buildIntent({ agentId: "generic-demo", marketBias: "bearish", protocolPreference: "raydium" });
  console.log("  LLM-generated intent:");
  console.log("   protocol   :", intent.protocol);
  console.log("   amountSol  :", intent.amountSol);
  console.log("   slippageBps:", intent.slippageBps);
  console.log("   rationale  :", intent.rationale);

  await runSwarm(`3. Generic LLM Swarm (${model}, 6 agents)`, engine);
} else {
  hr();
  console.log("  3. Generic LLM — SKIPPED");
  console.log("  Set LLM_ENDPOINT + LLM_MODEL to use any OpenAI-compatible provider:");
  console.log("    Ollama:     LLM_ENDPOINT=http://localhost:11434/v1/chat/completions LLM_MODEL=phi3");
  console.log("    Together:   LLM_ENDPOINT=https://api.together.xyz/v1/chat/completions LLM_API_KEY=... LLM_MODEL=mistralai/Mistral-7B-Instruct-v0.3");
  console.log("    Mistral AI: LLM_ENDPOINT=https://api.mistral.ai/v1/chat/completions LLM_API_KEY=... LLM_MODEL=mistral-small-latest");
}

// ── 4. Attack simulation ──────────────────────────────────────────────────────

hr();
console.log("  4. Attack Simulation — PolicyGuard rejection test");
const atkSwarm = new SwarmExecutor();
atkSwarm.spawnAgents(6);
const [atkAgent] = atkSwarm.agents;

if (atkAgent) {
  try {
    await atkAgent.processIntent({
      agentId: "attacker", type: "swap", protocol: "jupiter",
      amountSol: 10, slippageBps: 80, rationale: "hack",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      timestamp: new Date()
    });
    console.log("  ⚠️  Unexpected: attack not blocked.");
  } catch (err) {
    console.log("  ✅ Attack blocked:", err instanceof Error ? err.message : err);
  }
}

hr();
console.log("  All demo sections complete.");
