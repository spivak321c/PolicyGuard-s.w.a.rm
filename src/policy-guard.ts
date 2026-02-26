import { formatISO } from "date-fns";
import pino from "pino";
import {
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type Connection,
  type Keypair,
  PublicKey
} from "@solana/web3.js";
import type { AgentIntent, PolicyConfig, PolicyAuditRecord } from "./types";
import { PolicyViolationError } from "./types";
import { PolicyVaultClient } from "./policy-vault";

const logger = pino({ name: "policy-guard" });

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";
const RAYDIUM_HEALTH_URL = "https://api-v3.raydium.io/health";

// Devnet burn address — safe target for demo transfers when a real pool isn't available.
const DEVNET_DEMO_RECIPIENT = new PublicKey("11111111111111111111111111111111");

export class PolicyGuard {
  private readonly spendLedger = new Map<string, { date: string; spentSol: number; lastIntentTs: number }>();

  constructor(
    private readonly config: PolicyConfig,
    private readonly connection: Connection,
    private readonly signer: Keypair,
    private readonly policyVault: PolicyVaultClient
  ) { }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  async validateAndExecute(intent: AgentIntent): Promise<string> {
    // 1) Rationale quality check.
    if (this.config.requireReasonString && intent.rationale.trim().length < 10) {
      throw await this.violation(intent, "RATIONALE_REQUIRED", "Intent rationale must be present and meaningful.");
    }

    // 2) Protocol allowlist.
    if (!this.config.allowedProtocols.includes(intent.protocol)) {
      throw await this.violation(intent, "PROTOCOL_BLOCKED", `Protocol ${intent.protocol} is not allowlisted.`);
    }

    // 3) Mint allowlist.
    const mintSet = [intent.inputMint, intent.outputMint].filter(Boolean) as string[];
    if (mintSet.some((mint) => !this.config.allowedMints.includes(mint))) {
      throw await this.violation(intent, "MINT_BLOCKED", "Intent includes a token mint that is not allowlisted.");
    }

    // 4) Per-transaction SOL ceiling.
    if (intent.amountSol > this.config.maxSolPerTransaction) {
      throw await this.violation(intent, "MAX_TX_EXCEEDED", `Amount ${intent.amountSol} SOL exceeds per-tx cap of ${this.config.maxSolPerTransaction}.`);
    }

    // 5) Daily cumulative SOL ceiling.
    const key = intent.agentId;
    const day = formatISO(intent.timestamp, { representation: "date" });
    const current = this.spendLedger.get(key);
    const currentSpend = current && current.date === day ? current.spentSol : 0;
    if (currentSpend + intent.amountSol > this.config.maxSolDaily) {
      throw await this.violation(intent, "MAX_DAILY_EXCEEDED", `Daily spend limit of ${this.config.maxSolDaily} SOL would be exceeded (spent ${currentSpend} so far).`);
    }

    // 6) Slippage bounds.
    if (intent.slippageBps > this.config.maxSlippageBps) {
      throw await this.violation(intent, "SLIPPAGE_TOO_HIGH", `Slippage ${intent.slippageBps} bps exceeds policy cap of ${this.config.maxSlippageBps}.`);
    }

    // 7) Cooldown between intents.
    const nowTs = intent.timestamp.getTime();
    if (current && nowTs - current.lastIntentTs < this.config.cooldownSeconds * 1000) {
      throw await this.violation(intent, "COOLDOWN_ACTIVE", `Agent cooldown of ${this.config.cooldownSeconds}s has not elapsed.`);
    }

    // 8) Network, blocked-address, and reserve floor checks.
    const endpoint = this.connection.rpcEndpoint.toLowerCase();
    if (this.config.enforceDevnetOnly && !endpoint.includes("devnet")) {
      throw await this.violation(intent, "NETWORK_REJECTED", "Only devnet RPC endpoints are permitted.");
    }

    const targetAddress = this.extractTargetAddress(intent);
    if (targetAddress && this.config.blockedAddresses.includes(targetAddress)) {
      throw await this.violation(intent, "BLOCKED_ADDRESS", `Target address ${targetAddress} is blocked by policy.`);
    }

    const balanceLamports = await this.connection.getBalance(this.signer.publicKey);
    const reserveLamports = Math.floor(this.config.minTreasuryReserveSol * LAMPORTS_PER_SOL);
    const costLamports = Math.floor(intent.amountSol * LAMPORTS_PER_SOL);
    if (balanceLamports - costLamports < reserveLamports) {
      throw await this.violation(intent, "RESERVE_GUARD", `Balance would fall below treasury reserve floor of ${this.config.minTreasuryReserveSol} SOL.`);
    }

    // ── All checks passed — execute. ──────────────────────────────────────────
    const signature = await this.execute(intent);

    this.spendLedger.set(key, {
      date: day,
      spentSol: currentSpend + intent.amountSol,
      lastIntentTs: nowTs
    });

    const record: PolicyAuditRecord = {
      agentId: intent.agentId,
      intentType: intent.type,
      protocol: intent.protocol,
      approved: true,
      reason: "Approved and executed",
      amountSol: intent.amountSol,
      signature,
      timestamp: new Date()
    };

    try {
      await this.policyVault.logAction(record);
    } catch (err) {
      logger.error({ err, agentId: intent.agentId }, "Failed to write approval audit record — continuing.");
    }

    logger.info({ signature, agentId: intent.agentId }, "Intent executed successfully.");
    return signature;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: execution routing
  // ─────────────────────────────────────────────────────────────────────────────

  private async execute(intent: AgentIntent): Promise<string> {
    logger.info({ protocol: intent.protocol, agentId: intent.agentId }, "Executing approved intent.");

    if (intent.protocol === "jupiter" && intent.inputMint && intent.outputMint) {
      return this.executeJupiterSwap(intent);
    }

    if (intent.protocol === "raydium") {
      return this.executeRaydiumDemo(intent);
    }

    // Generic fallback for transfer intents.
    return this.executeTransfer(intent);
  }

  // ── Jupiter v6 real swap ────────────────────────────────────────────────────

  private async executeJupiterSwap(intent: AgentIntent): Promise<string> {
    const amountLamports = Math.floor(intent.amountSol * LAMPORTS_PER_SOL);

    // Step 1: get a quote.
    const quoteUrl = new URL(JUPITER_QUOTE_URL);
    quoteUrl.searchParams.set("inputMint", intent.inputMint!);
    quoteUrl.searchParams.set("outputMint", intent.outputMint!);
    quoteUrl.searchParams.set("amount", String(amountLamports));
    quoteUrl.searchParams.set("slippageBps", String(intent.slippageBps));

    const quoteRes = await fetch(quoteUrl.toString());
    if (!quoteRes.ok) {
      const body = await quoteRes.text();
      throw await this.violation(intent, "JUPITER_QUOTE_FAILED", `Jupiter quote failed (${quoteRes.status}): ${body.slice(0, 200)}`);
    }
    const quoteData = await quoteRes.json() as Record<string, unknown>;
    logger.info({ outAmount: quoteData.outAmount, agentId: intent.agentId }, "Jupiter quote received.");

    // Step 2: get swap transaction.
    const swapRes = await fetch(JUPITER_SWAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: this.signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto"
      })
    });

    if (!swapRes.ok) {
      const body = await swapRes.text();
      throw await this.violation(intent, "JUPITER_SWAP_FAILED", `Jupiter swap build failed (${swapRes.status}): ${body.slice(0, 200)}`);
    }

    const { swapTransaction } = await swapRes.json() as { swapTransaction: string };

    // Step 3: deserialize, sign, and submit.
    const txBytes = Buffer.from(swapTransaction, "base64");
    const vTx = VersionedTransaction.deserialize(txBytes);
    vTx.sign([this.signer]);

    const signature = await this.connection.sendTransaction(vTx, {
      maxRetries: 3,
      skipPreflight: false
    });

    logger.info({ signature, agentId: intent.agentId }, "Jupiter swap submitted to devnet.");

    // Step 4: wait for confirmation.
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

    return signature;
  }

  // ── Raydium demo: real SOL transfer to a devnet address ─────────────────────
  // Full Raydium LP requires an initialized pool keypair and base/quote deposits.
  // This demo tier sends a real, confirmed devnet transaction and documents why
  // full LP integration requires the pool to be pre-initialized.

  private async executeRaydiumDemo(intent: AgentIntent): Promise<string> {
    // Verify Raydium API is live before touching chain.
    const healthRes = await fetch(RAYDIUM_HEALTH_URL);
    if (!healthRes.ok) {
      throw await this.violation(intent, "RAYDIUM_UNREACHABLE", `Raydium health endpoint returned ${healthRes.status}.`);
    }

    logger.info({ agentId: intent.agentId }, "Raydium health OK — submitting devnet transfer as LP placeholder.");
    return this.executeTransfer(intent);
  }

  // ── Generic confirmed transfer ───────────────────────────────────────────────

  private async executeTransfer(intent: AgentIntent): Promise<string> {
    const lamports = Math.floor(intent.amountSol * LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: this.signer.publicKey
    }).add(
      SystemProgram.transfer({
        fromPubkey: this.signer.publicKey,
        toPubkey: DEVNET_DEMO_RECIPIENT,
        lamports
      })
    );

    tx.sign(this.signer);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

    logger.info({ signature, agentId: intent.agentId }, "Transfer confirmed on devnet.");
    return signature;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private extractTargetAddress(intent: AgentIntent): string | undefined {
    const t = intent.metadata?.targetAddress;
    return typeof t === "string" ? t : undefined;
  }

  private async violation(intent: AgentIntent, code: string, reason: string): Promise<PolicyViolationError> {
    const record: PolicyAuditRecord = {
      agentId: intent.agentId,
      intentType: intent.type,
      protocol: intent.protocol,
      approved: false,
      reason,
      amountSol: intent.amountSol,
      timestamp: new Date()
    };

    try {
      await this.policyVault.logAction(record);
    } catch (err) {
      logger.error({ err, code, reason }, "Failed to write rejection audit record.");
    }

    logger.warn({ code, reason, agentId: intent.agentId }, "Intent rejected.");
    return new PolicyViolationError(code, reason);
  }
}
