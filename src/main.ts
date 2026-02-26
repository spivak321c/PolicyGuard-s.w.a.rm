#!/usr/bin/env bun
import { Keypair } from "@solana/web3.js";
import {
  ScriptedDecisionEngine,
  GroqDecisionEngine,
  GenericLLMEngine
} from "./agent-logic";
import { SwarmExecutor } from "./swarm-executor";
import type { IAgentDecisionEngine } from "./types";

function parseFlag(args: string[], flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

function parseAgentsArg(args: string[]): number {
  const v = Number(parseFlag(args, "agents") ?? "6");
  return Number.isFinite(v) && v >= 1 ? v : 6;
}

function parseRpcArg(args: string[]): string {
  return parseFlag(args, "rpc") ?? process.env.SOLANA_RPC_URL ?? "";
}

function buildEngine(args: string[]): IAgentDecisionEngine {
  const name = (parseFlag(args, "engine") ?? process.env.AGENT_ENGINE ?? "scripted").toLowerCase();

  switch (name) {
    case "groq":
      // Use "llama-3.1-8b-instant" as default (llama3-8b-8192 is decommissioned).
      return new GroqDecisionEngine(process.env.GROQ_MODEL ?? "llama-3.1-8b-instant");

    case "generic": {
      // Reads LLM_ENDPOINT, LLM_API_KEY, LLM_MODEL from environment.
      return GenericLLMEngine.fromEnv();
    }

    default:
      return new ScriptedDecisionEngine();
  }
}

async function createWallet(): Promise<void> {
  const wallet = Keypair.generate();
  console.log("New wallet created:", wallet.publicKey.toBase58());
  console.log("Keys are isolated in runtime memory — never passed to AI engines.");
  console.log("\nFund this wallet on devnet:");
  console.log(`  solana airdrop 2 ${wallet.publicKey.toBase58()} --url devnet`);
}

async function runSwarm(args: string[]): Promise<void> {
  const count = parseAgentsArg(args);
  const rpc = parseRpcArg(args);
  const engine = buildEngine(args);

  const engineName = engine.constructor.name;
  console.log(`Engine: ${engineName} | Agents: ${count} | RPC: ${rpc || "devnet (default)"}`);

  const swarm = rpc ? new SwarmExecutor(rpc, engine) : new SwarmExecutor(undefined, engine);
  swarm.spawnAgents(count);

  // Live per-agent event output.
  swarm.events.on("intent.created", (e) => {
    const intent = e.payload.intent as { protocol: string; amountSol: number };
    console.log(`[${e.agentId}] 📋 ${intent?.protocol ?? "?"} ${intent?.amountSol ?? "?"}◎`);
  });
  swarm.events.on("intent.executed", (e) => {
    console.log(`[${e.agentId}] ✅ Signature: ${e.payload.sig as string}`);
  });
  swarm.events.on("intent.rejected", (e) => {
    const err = e.payload.error;
    const phase = e.payload.phase === "generation" ? "[GENERATE_ERROR]" : "[POLICY_REJECTED]";
    console.log(`[${e.agentId}] ❌ ${phase}: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Automatically ensure airdrops on devnet if not explicitly disabled.
  if (!parseFlag(args, "no-airdrop")) {
    const airdropRpc = parseFlag(args, "airdrop-rpc");
    await swarm.ensureAirdrops(airdropRpc);
  }

  const results = await swarm.runCoordinatedYieldStrategy();
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const bad = results.filter((r) => r.status === "rejected").length;
  console.log(`\nSwarm complete — ${ok} executed, ${bad} rejected out of ${results.length} agents.`);
}

async function attackTest(args: string[]): Promise<void> {
  const rpc = parseRpcArg(args);
  const swarm = rpc ? new SwarmExecutor(rpc) : new SwarmExecutor();
  const [agent] = swarm.spawnAgents(6);
  if (!agent) throw new Error("Failed to spawn agent.");

  const malicious = {
    agentId: "attacker-1",
    type: "swap" as const,
    protocol: "jupiter" as const,
    amountSol: 10,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    slippageBps: 80,
    rationale: "hack",
    timestamp: new Date()
  };

  console.log("Simulating malicious intent (amountSol=10, rationale='hack')...");
  try {
    await agent.processIntent(malicious);
    console.log("⚠️  Unexpected: intent was NOT rejected.");
  } catch (err) {
    console.log("✅ Rejected as expected:", err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2);

  switch (command) {
    case "create-wallet": await createWallet(); break;
    case "run-swarm": await runSwarm(rest); break;
    case "attack-test": await attackTest(rest); break;
    default:
      console.log(`
Usage:
  bun run src/main.ts create-wallet
  bun run src/main.ts run-swarm   [--agents=6] [--rpc=<url>] [--airdrop-rpc=<url>] [--engine=scripted|groq|generic]
  bun run src/main.ts attack-test [--rpc=<url>]

Engines:
  scripted   No API key needed (default)
  groq       Requires: GROQ_API_KEY
             Optional: GROQ_MODEL (default: llama-3.1-8b-instant)
  generic    Any OpenAI-compatible provider via:
             LLM_ENDPOINT  e.g. https://api.groq.com/openai/v1/chat/completions
             LLM_API_KEY   Bearer token (blank for local providers)
             LLM_MODEL     e.g. llama-3.1-8b-instant, phi3, mistral

Examples:
  # Groq
  GROQ_API_KEY=gsk_... bun run src/main.ts run-swarm --engine=groq

  # Using split RPCs (Faucet on dRPC, main logic on public devnet)
  bun run src/main.ts run-swarm --engine=groq \\
    --airdrop-rpc=https://solana-devnet.drpc.org

  # Ollama (local, no key)
  LLM_ENDPOINT=http://localhost:11434/v1/chat/completions LLM_MODEL=phi3 \\
    bun run src/main.ts run-swarm --engine=generic

  # Together AI
  LLM_ENDPOINT=https://api.together.xyz/v1/chat/completions \\
  LLM_API_KEY=your_key LLM_MODEL=mistralai/Mistral-7B-Instruct-v0.3 \\
    bun run src/main.ts run-swarm --engine=generic
      `);
  }
}

await main();
