import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

export type IntentType = "swap" | "add-liquidity" | "remove-liquidity" | "transfer";

export interface AgentIntent {
  agentId: string;
  type: IntentType;
  protocol: "jupiter" | "raydium";
  amountSol: number;
  inputMint?: string;
  outputMint?: string;
  slippageBps: number;
  rationale: string;
  metadata?: Record<string, string | number | boolean>;
  timestamp: Date;
}

export interface PolicyConfig {
  maxSolPerTransaction: number;
  maxSolDaily: number;
  maxSlippageBps: number;
  allowedProtocols: Array<"jupiter" | "raydium">;
  allowedMints: string[];
  blockedAddresses: string[];
  cooldownSeconds: number;
  requireReasonString: boolean;
  enforceDevnetOnly: boolean;
  minTreasuryReserveSol: number;
}

export class PolicyViolationError extends Error {
  public readonly code: string;
  public readonly reason: string;

  constructor(code: string, reason: string) {
    super(`Policy violation [${code}]: ${reason}`);
    this.name = "PolicyViolationError";
    this.code = code;
    this.reason = reason;
  }
}

export interface PolicyAuditRecord {
  agentId: string;
  intentType: IntentType;
  protocol: string;
  approved: boolean;
  reason: string;
  amountSol: number;
  signature?: string;
  timestamp: Date;
}

export interface WalletExecutionContext {
  owner: PublicKey;
  balanceSol: number;
  instructions: TransactionInstruction[];
  targetAddresses: string[];
}

export interface SwarmAgent {
  id: string;
  walletAddress: string;
  role: "maker" | "arbiter" | "liquidity" | "risk" | "hedge" | "executor";
  status: "idle" | "planning" | "executing" | "paused";
  dailySpendSol: number;
  processIntent: (intent: AgentIntent) => Promise<string>;
}

export interface SwarmEvent {
  id: string;
  type: "intent.created" | "intent.executed" | "intent.rejected" | "coordination.note";
  agentId: string;
  payload: Record<string, unknown>;
  timestamp: Date;
}

export interface IAgentDecisionEngine {
  buildIntent(input: {
    agentId: string;
    marketBias: "bullish" | "bearish" | "neutral";
    protocolPreference: "jupiter" | "raydium";
  }): Promise<AgentIntent>;
}
