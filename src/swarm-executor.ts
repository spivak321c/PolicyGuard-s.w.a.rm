import { AnchorProvider } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  SystemProgram,
  clusterApiUrl
} from "@solana/web3.js";
import { ScriptedDecisionEngine } from "./agent-logic";
import type { IAgentDecisionEngine } from "./types";
import { getDefaultPolicyConfig } from "./policy-config";
import { PolicyGuard } from "./policy-guard";
import { PolicyVaultClient } from "./policy-vault";
import type { AgentIntent, SwarmAgent, SwarmEvent } from "./types";
import pino from "pino";

const logger = pino({ name: "swarm-executor", level: process.env.SWARM_TECHNICAL_LOGS === "1" ? "info" : "silent" });

interface AnchorWalletLike {
  publicKey: Keypair["publicKey"];
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

// ── Event bus ────────────────────────────────────────────────────────────────
// Each event is published on BOTH its typed topic ("intent.created", etc.)
// AND the catch-all "swarm.event" topic, so subscribers can listen either way.

class InMemorySwarmBus {
  private listeners = new Map<string, Array<(event: SwarmEvent) => void>>();

  on(topic: string, listener: (event: SwarmEvent) => void): void {
    const existing = this.listeners.get(topic) ?? [];
    existing.push(listener);
    this.listeners.set(topic, existing);
  }

  emit(topic: string, event: SwarmEvent): void {
    for (const listener of this.listeners.get(topic) ?? []) {
      listener(event);
    }
    // Also notify catch-all subscribers if this is a typed event.
    if (topic !== "swarm.event") {
      for (const listener of this.listeners.get("swarm.event") ?? []) {
        listener(event);
      }
    }
  }
}

const ROLES: SwarmAgent["role"][] = ["maker", "arbiter", "liquidity", "risk", "hedge", "executor"];

function createAnchorWallet(keypair: Keypair): AnchorWalletLike {
  return {
    publicKey: keypair.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof Transaction) {
        tx.partialSign(keypair);
      } else {
        tx.sign([keypair]);
      }
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      for (const tx of txs) {
        if (tx instanceof Transaction) {
          tx.partialSign(keypair);
        } else {
          tx.sign([keypair]);
        }
      }
      return txs;
    }
  };
}

export interface SwarmRunResult {
  agentId: string;
  status: "fulfilled" | "rejected";
  signature?: string;
  error?: string;
}

export class SwarmExecutor {
  readonly connection: Connection;
  readonly events = new InMemorySwarmBus();
  readonly agents: SwarmAgent[] = [];
  private readonly decisionEngine: IAgentDecisionEngine;

  constructor(endpoint = clusterApiUrl("devnet"), decisionEngine?: IAgentDecisionEngine) {
    this.connection = new Connection(endpoint, "confirmed");
    this.decisionEngine = decisionEngine ?? new ScriptedDecisionEngine();
  }

  spawnAgents(count = 6): SwarmAgent[] {
    // Two-pass spawn: first generate keypairs, then create PolicyGuards with peer addresses.
    const keypairs: Keypair[] = [];
    for (let i = 0; i < count; i += 1) {
      keypairs.push(Keypair.generate());
    }

    // Collect all wallet addresses so each PolicyGuard knows its peers.
    const allAddresses = keypairs.map((kp) => kp.publicKey.toBase58());

    for (let i = 0; i < count; i += 1) {
      const keypair = keypairs[i]!;
      const wallet = createAnchorWallet(keypair);
      const provider = new AnchorProvider(this.connection, wallet, {});
      const vault = new PolicyVaultClient(provider);
      const config = getDefaultPolicyConfig();
      // Pass all agent addresses so PolicyGuard can target peers (not self).
      const guard = new PolicyGuard(config, this.connection, keypair, vault, allAddresses);

      const agent: SwarmAgent = {
        id: `agent-${i + 1}`,
        walletAddress: keypair.publicKey.toBase58(),
        role: ROLES[i % ROLES.length] ?? "executor",
        status: "idle",
        dailySpendSol: 0,
        processIntent: async (intent: AgentIntent) => {
          agent.status = "executing";
          this.emitEvent("intent.created", agent.id, { intent });
          this.emitEvent("coordination.note", agent.id, {
            stage: "policy-check",
            message: "Requesting PolicyGuard approval before signing.",
            detail: this.describeIntent(intent)
          });
          try {
            this.emitEvent("coordination.note", agent.id, {
              stage: "transaction",
              message: "Policy approved. Submitting transaction to Solana devnet.",
              detail: this.describeIntent(intent)
            });
            const sig = await guard.validateAndExecute(intent);
            agent.dailySpendSol += intent.amountSol;
            this.emitEvent("intent.executed", agent.id, { sig, intent });
            this.emitEvent("coordination.note", agent.id, {
              stage: "transaction",
              message: "Transaction confirmed on-chain.",
              signature: sig
            });
            agent.status = "idle";
            return sig;
          } catch (error) {
            this.emitEvent("intent.rejected", agent.id, { error, intent });
            this.emitEvent("coordination.note", agent.id, {
              stage: "halt",
              message: "Execution halted due to rejection.",
              reason: error instanceof Error ? error.message : String(error)
            });
            agent.status = "paused";
            throw error;
          }
        }
      };

      this.agents.push(agent);
    }

    return this.agents;
  }

  /**
   * Distributes SOL to agents.
   * If funderWallet is provided, it transfers SOL from that master wallet.
   * Otherwise fallbacks to airdrops (which are easily rate limited on devnet).
   */
  async ensureFunding(funderWallet?: Keypair, airdropRpcUrl?: string): Promise<void> {
    const isDevnet = this.connection.rpcEndpoint.includes("devnet") || (airdropRpcUrl && airdropRpcUrl.includes("devnet"));
    if (!isDevnet) return;

    if (funderWallet) {
      console.log(`Checking balance and ensuring devnet funding from funder wallet for ${this.agents.length} agents...`);
      for (const agent of this.agents) {
        const pubkey = new PublicKey(agent.walletAddress);
        const balance = await this.connection.getBalance(pubkey);
        const balanceSol = balance / 10 ** 9;

        console.log(`  [${agent.id}] Balance: ${balanceSol.toFixed(3)}◎`);

        if (balance < 0.5 * 10 ** 9) {
          try {
            console.log(`  [${agent.id}] Transferring 0.3 SOL from funder...`);
            const tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: funderWallet.publicKey,
                toPubkey: pubkey,
                lamports: 0.3 * 10 ** 9,
              })
            );
            const latestBlockhash = await this.connection.getLatestBlockhash();
            tx.recentBlockhash = latestBlockhash.blockhash;
            tx.feePayer = funderWallet.publicKey;
            tx.sign(funderWallet);

            const sig = await this.connection.sendRawTransaction(tx.serialize());
            await this.connection.confirmTransaction({
              signature: sig,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            });
            console.log(`  [${agent.id}] Funded ✅ Current: ${(await this.connection.getBalance(pubkey) / 10 ** 9).toFixed(3)}◎`);
          } catch (err) {
            console.warn(`  [${agent.id}] Funding failed:`, err instanceof Error ? err.message : String(err));
          }
        }
      }
      return;
    }

    const faucetConn = airdropRpcUrl ? new Connection(airdropRpcUrl, "confirmed") : this.connection;

    console.log(`Checking balance and ensuring devnet airdrops for ${this.agents.length} agents...`);
    if (airdropRpcUrl) {
      console.log(`  (Using faucet RPC: ${airdropRpcUrl})`);
    }

    await Promise.allSettled(
      this.agents.map(async (agent) => {
        const pubkey = new PublicKey(agent.walletAddress);
        const balance = await this.connection.getBalance(pubkey);
        const balanceSol = balance / 10 ** 9;

        console.log(`  [${agent.id}] Balance: ${balanceSol.toFixed(3)}◎`);

        if (balance < 0.5 * 10 ** 9) {
          try {
            console.log(`  [${agent.id}] Requesting airdrop (2 SOL)...`);
            const sig = await faucetConn.requestAirdrop(pubkey, 2 * 10 ** 9);
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
              signature: sig,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            });
            console.log(`  [${agent.id}] Airdropped ✅ Current: ${(await this.connection.getBalance(pubkey) / 10 ** 9).toFixed(3)}◎`);
          } catch (err) {
            console.warn(`  [${agent.id}] Airdrop failed:`, err instanceof Error ? err.message : String(err));
          }
        }
      })
    );
  }

  private describeIntent(intent: AgentIntent): string {
    const route = `${intent.protocol.toUpperCase()} ${intent.type}`;
    const amount = `${intent.amountSol} SOL`;
    const slippage = `${intent.slippageBps}bps`;
    return `${route} | amount=${amount} | slippage=${slippage}`;
  }

  // ── Run all agents concurrently ──────────────────────────────────────────────
  // Uses Promise.allSettled so a single agent rejection does not abort the swarm.

  async runCoordinatedYieldStrategy(): Promise<SwarmRunResult[]> {
    if (this.agents.length === 0) {
      console.log("No agents spawned, creating default swarm of 6...");
      this.spawnAgents(6);
    }

    const tasks = this.agents.map(async (agent, index): Promise<SwarmRunResult> => {
      const marketBias = index % 2 === 0 ? "bullish" : "neutral";
      const protocolPreference = index % 3 === 0 ? "raydium" : "jupiter";
      try {
        agent.status = "planning";
        this.emitEvent("coordination.note", agent.id, {
          stage: "thinking",
          message: "Analyzing market context and drafting an intent.",
          marketBias,
          protocolPreference
        });
        const intent = await this.decisionEngine.buildIntent({
          agentId: agent.id,
          marketBias,
          protocolPreference
        });
        this.emitEvent("coordination.note", agent.id, {
          stage: "communication",
          message: "Intent drafted and shared with the swarm coordinator.",
          rationale: intent.rationale,
          detail: this.describeIntent(intent)
        });

        const sig = await agent.processIntent(intent);
        return { agentId: agent.id, status: "fulfilled", signature: sig };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Ensure intent.rejected event fires even if buildIntent fails
        if (agent.status !== "executing") {
          this.emitEvent("intent.rejected", agent.id, { error: message, phase: "generation" });
          this.emitEvent("coordination.note", agent.id, {
            stage: "halt",
            message: "Intent generation failed before execution.",
            reason: message
          });
        }
        return { agentId: agent.id, status: "rejected", error: message };
      }
    });

    const results = await Promise.allSettled(tasks);

    return results.map((r) => {
      if (r.status === "fulfilled") return r.value;
      // Promise.allSettled itself won't reject since we catch inside each task,
      // but guard defensively.
      return { agentId: "unknown", status: "rejected", error: String(r.reason) };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private emitEvent(type: SwarmEvent["type"], agentId: string, payload: Record<string, unknown>): void {
    const event: SwarmEvent = {
      id: `${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      agentId,
      payload,
      timestamp: new Date()
    };
    logger.info({ type, agentId }, "Swarm event.");
    this.events.emit(type, event);
  }
}
