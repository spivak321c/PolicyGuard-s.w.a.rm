#!/usr/bin/env bun
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import {
  ScriptedDecisionEngine
} from "./agent-logic";
import { SwarmExecutor } from "./swarm-executor";
import { ModelRegistry } from "./ai-engines/model-registry";
import { CoordinatorEngine } from "./ai-engines/coordinator-engine";
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
  const raw = parseFlag(args, "agents");
  if (raw === undefined) return 6;

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid --agents value: expected a positive integer (example: --agents=3).");
  }

  const v = Number(trimmed);
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`Invalid --agents value '${raw}': expected a positive integer.`);
  }

  return v;
}

function parseRpcArg(args: string[]): string {
  return parseFlag(args, "rpc") ?? process.env.SOLANA_RPC_URL ?? "";
}

function buildEngine(args: string[]): IAgentDecisionEngine {
  ModelRegistry.registerFromEnv();

  const name = (parseFlag(args, "engine") ?? process.env.AGENT_ENGINE ?? "scripted").toLowerCase();
  const coordinatorFlag = parseFlag(args, "coordinator");

  if (name === "scripted") {
    return new ScriptedDecisionEngine();
  }

  if (coordinatorFlag) {
    const steps = coordinatorFlag
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [model, role] = entry.split(":");
        return {
          model: (model ?? "").trim(),
          role: (role ?? "reviewer").trim()
        };
      })
      .filter((step) => step.model.length > 0 && step.role.length > 0);

    if (steps.length >= 2) {
      return new CoordinatorEngine(steps);
    }

    console.warn("Coordinator requested but fewer than 2 valid steps were provided; falling back to scripted engine.");
    return new ScriptedDecisionEngine();
  }

  try {
    return ModelRegistry.get(name);
  } catch (err) {
    console.warn(`Unknown or unregistered engine '${name}', falling back to scripted.`, err);
    return new ScriptedDecisionEngine();
  }
}



function loadOrCreateAgentWallets(path: string, count: number): Keypair[] {
  if (!fs.existsSync(path)) {
    const generated = Array.from({ length: count }, () => Keypair.generate());
    fs.writeFileSync(path, JSON.stringify(generated.map((k) => Array.from(k.secretKey)), null, 2));
    console.log(`
Agent wallet store created: ${path}`);
    return generated;
  }

  const raw = JSON.parse(fs.readFileSync(path, "utf-8")) as number[][];
  const loaded = raw
    .filter((arr) => Array.isArray(arr) && arr.length >= 64)
    .map((arr) => Keypair.fromSecretKey(new Uint8Array(arr)));

  const keypairs = [...loaded];
  while (keypairs.length < count) {
    keypairs.push(Keypair.generate());
  }

  if (keypairs.length !== loaded.length) {
    fs.writeFileSync(path, JSON.stringify(keypairs.map((k) => Array.from(k.secretKey)), null, 2));
    console.log(`Updated agent wallet store with ${keypairs.length - loaded.length} additional wallet(s): ${path}`);
  }

  return keypairs.slice(0, count);
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

  const withPeerTransfer = (parseFlag(args, "with-peer-transfer") ?? "false").toLowerCase() === "true";
  if (withPeerTransfer) {
    process.env.SWAP_WITH_PEER_SPL_TRANSFER = "true";
  }

  const engineName = engine.constructor.name;
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🚀 Starting PolicyGuard Swarm Run");
  console.log(`• Engine: ${engineName}`);
  console.log(`• Agents: ${count}`);
  console.log(`• RPC: ${rpc || "devnet (default)"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const swarm = rpc ? new SwarmExecutor(rpc, engine) : new SwarmExecutor(undefined, engine);

  const agentsFile = parseFlag(args, "agents-file");
  const persistedAgents = agentsFile ? loadOrCreateAgentWallets(agentsFile, count) : undefined;
  const agents = swarm.spawnAgents(count, undefined, persistedAgents);
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
    const msg = err instanceof Error
      ? err.message
      : (typeof err === "object" && err !== null ? JSON.stringify(err) : String(err));
    console.log(`[${e.agentId}] ❌ Rejected during ${phase}: ${msg}`);
  });

  const funderWallet = loadFunderWallet(args);
  if (!funderWallet) {
    console.error(
      "\nERROR: A funder wallet is required to fund agents on devnet."
    );
    console.error(
      "Create one with: bun run src/main.ts run-swarm --funder=funder.json"
    );
    console.error(
      "Then fund it: solana airdrop 5 <ADDRESS> --url devnet"
    );
    process.exit(1);
  }
  await swarm.ensureFunding(funderWallet);

  console.log("Waiting 3s for devnet RPC nodes to sync balances...");
  await new Promise((r) => setTimeout(r, 3000));

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
    protocol: "raydium" as const,
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
  bun run src/main.ts run-swarm   [--agents=6] [--rpc=<url>] [--agents-file=<path.json>] [--with-peer-transfer=true|false] [--airdrop-rpc=<url>] [--engine=scripted|groq|gemini|openai|openrouter|mistral|ollama|generic|coordinator] [--coordinator=model1:role1,model2:role2,...]
  bun run src/main.ts attack-test [--rpc=<url>]

Engines:
  scripted      No API key needed (default)
  groq          Requires: GROQ_API_KEY (+ GROQ_MODEL)
  gemini        Requires: GEMINI_API_KEY (+ GEMINI_MODEL)
  openai        Requires: OPENAI_API_KEY (+ OPENAI_MODEL)
  openrouter    Requires: OPENROUTER_API_KEY (+ OPENROUTER_MODEL)
  mistral       Requires: MISTRAL_API_KEY (+ MISTRAL_MODEL)
  together      Requires: TOGETHER_API_KEY (+ TOGETHER_MODEL)
  ollama        Requires: OLLAMA_ENDPOINT + OLLAMA_MODEL
  generic       Requires: LLM_ENDPOINT + LLM_MODEL (+ optional LLM_API_KEY)
  coordinator   Use --coordinator=model:role,model:role (2+ steps)

Custom model env pattern:
  MODEL_<n>_ENDPOINT, MODEL_<n>_KEY, MODEL_<n>_ID (registers engine name "<n>")

Coordinator examples:
  # 2-model chain
  bun run src/main.ts run-swarm --engine=coordinator --coordinator=groq:planner,openai:reviewer

  # 3-model chain
  bun run src/main.ts run-swarm --engine=coordinator --coordinator=groq:planner,gemini:risk,mistral:finalizer

Examples:
  # Use single funder wallet
  GROQ_API_KEY=gsk_... GROQ_MODEL=llama-3.1-8b-instant \
    bun run src/main.ts run-swarm --engine=groq --funder=funder.json

  # Ollama (local, no key)
  OLLAMA_ENDPOINT=http://localhost:11434/v1/chat/completions OLLAMA_MODEL=phi3 \
    bun run src/main.ts run-swarm --engine=ollama

  # Generic endpoint
  LLM_ENDPOINT=https://api.together.xyz/v1/chat/completions \
  LLM_API_KEY=your_key LLM_MODEL=mistralai/Mistral-7B-Instruct-v0.3 \
    bun run src/main.ts run-swarm --engine=generic

  # Persist agent wallets across runs
  bun run src/main.ts run-swarm --agents=2 --agents-file=agents.json --engine=coordinator --coordinator=groq:planner,openai:reviewer --with-peer-transfer=true      `);
  }
}

await main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
});
