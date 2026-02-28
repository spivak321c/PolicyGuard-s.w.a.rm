#!/usr/bin/env bun
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import {
  ScriptedDecisionEngine,
  GroqDecisionEngine,
  GenericLLMEngine
} from "./agent-logic";
import { SwarmExecutor } from "./swarm-executor";
import type { IAgentDecisionEngine } from "./types";


function shortAddress(address: string, left = 4, right = 4): string {
  if (address.length <= left + right + 3) return address;
  return `${address.slice(0, left)}...${address.slice(-right)}`;
}

function printAgentHeader(agentId: string): void {
  console.log(`
[${agentId}]`);
}

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

function loadFunderWallet(args: string[]): Keypair | undefined {
  const funderPath = parseFlag(args, "funder");
  if (!funderPath) return undefined;

  if (!fs.existsSync(funderPath)) {
    const newWallet = Keypair.generate();
    fs.writeFileSync(funderPath, JSON.stringify(Array.from(newWallet.secretKey)));
    console.log(`\nFunder wallet created at: ${funderPath}`);
    console.log(`Address: ${newWallet.publicKey.toBase58()}`);
    console.log(`Please fund this wallet via the faucet before running the swarm:`);
    console.log(`  solana airdrop 5 ${newWallet.publicKey.toBase58()} --url devnet\n`);
    process.exit(1);
  }

  const secretKey = new Uint8Array(JSON.parse(fs.readFileSync(funderPath, "utf-8")));
  return Keypair.fromSecretKey(secretKey);
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
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🚀 Starting PolicyGuard Swarm Run");
  console.log(`• Engine: ${engineName}`);
  console.log(`• Agents: ${count}`);
  console.log(`• RPC: ${rpc || "devnet (default)"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const swarm = rpc ? new SwarmExecutor(rpc, engine) : new SwarmExecutor(undefined, engine);
  const agents = swarm.spawnAgents(count);
  console.log("👥 Spawned agents:");
  for (const agent of agents) {
    console.log(`   - ${agent.id} (${agent.role}) wallet=${shortAddress(agent.walletAddress)}`);
  }

  // Live per-agent event output.
  swarm.events.on("coordination.note", (e) => {
    const stage = String(e.payload.stage ?? "note");
    const message = String(e.payload.message ?? "");
    const detail = typeof e.payload.detail === "string" ? ` | ${e.payload.detail}` : "";
    const rationale = typeof e.payload.rationale === "string" ? `\n   💬 Rationale: ${e.payload.rationale}` : "";
    const reason = typeof e.payload.reason === "string" ? `\n   ⚠️ Reason: ${e.payload.reason}` : "";
    const signature = typeof e.payload.signature === "string" ? `\n   🔗 Tx: ${e.payload.signature}` : "";
    console.log(`[${e.agentId}] 🛰️ ${stage}: ${message}${detail}${rationale}${reason}${signature}`);
  });

  swarm.events.on("intent.created", (e) => {
    const intent = e.payload.intent as {
      protocol: string;
      amountSol: number;
      slippageBps: number;
      rationale: string;
      inputMint?: string;
      outputMint?: string;
    };
    printAgentHeader(e.agentId);
    console.log(`🧠 Thinking result: I want to use ${intent?.protocol ?? "?"} for ${intent?.amountSol ?? "?"} SOL.`);
    console.log(`📦 Intent: slippage=${intent?.slippageBps ?? "?"}bps`);
    if (intent?.inputMint && intent?.outputMint) {
      console.log(`🔁 Route: ${shortAddress(intent.inputMint, 6, 6)} → ${shortAddress(intent.outputMint, 6, 6)}`);
    }
    console.log(`💬 Why: ${intent?.rationale ?? "No rationale provided"}`);
  });

  swarm.events.on("intent.executed", (e) => {
    const intent = e.payload.intent as { protocol?: string; amountSol?: number } | undefined;
    console.log(`[${e.agentId}] ✅ Transaction confirmed (${intent?.protocol ?? "intent"}, ${intent?.amountSol ?? "?"} SOL)`);
    console.log(`   🔗 Signature: ${e.payload.sig as string}`);
  });

  swarm.events.on("intent.rejected", (e) => {
    const err = e.payload.error;
    const phase = e.payload.phase === "generation" ? "intent generation" : "policy checks";
    console.log(`[${e.agentId}] ❌ Rejected during ${phase}: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Automatically ensure airdrops on devnet if not explicitly disabled.
  if (!parseFlag(args, "no-airdrop")) {
    const funderWallet = loadFunderWallet(args);
    const airdropRpc = parseFlag(args, "airdrop-rpc");
    await swarm.ensureFunding(funderWallet, airdropRpc);

    console.log("Waiting 3s for devnet RPC nodes to sync balances...");
    await new Promise((r) => setTimeout(r, 3000));
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

  const maliciousAmount = {
    ...malicious,
    amountSol: 10,
    slippageBps: 80,
    rationale: "Valid rationale to appear safe while draining funds."
  };

  console.log("Simulating malicious intent (amountSol=10, rationale='valid')...");
  try {
    await agent.processIntent(maliciousAmount);
    console.log("⚠️  Unexpected: intent was NOT rejected.");
  } catch (err) {
    console.log("✅ Rejected [amount too large]:", err instanceof Error ? err.message : err);
  }

  const maliciousSlippage = {
    ...malicious,
    amountSol: 0.1,
    slippageBps: 500,
    rationale: "Valid rationale to appear safe while hiding extreme slippage."
  };

  console.log("Simulating malicious intent (amountSol=0.1, slippageBps=500, rationale='valid')...");
  try {
    await agent.processIntent(maliciousSlippage);
    console.log("⚠️  Unexpected: intent was NOT rejected.");
  } catch (err) {
    console.log("✅ Rejected [slippage too high]:", err instanceof Error ? err.message : err);
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
  # Use single funder wallet
  GROQ_API_KEY=gsk_... bun run src/main.ts run-swarm --engine=groq --funder=funder.json

  # Using split RPCs (Faucet on dRPC, main logic on public devnet)
  bun run src/main.ts run-swarm --engine=groq \\
    --airdrop-rpc=https://api.devnet.solana.com

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
