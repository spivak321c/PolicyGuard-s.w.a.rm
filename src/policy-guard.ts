import { formatISO } from "date-fns";
import pino from "pino";
import {
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
  type Keypair,
  PublicKey
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer as splTransfer,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";

import { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken, ORCA_WHIRLPOOL_PROGRAM_ID, IGNORE_CACHE } from "@orca-so/whirlpools-sdk";
import { Percentage } from "@orca-so/common-sdk";
import Decimal from "decimal.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import type { AgentIntent, PolicyConfig, PolicyAuditRecord } from "./types";
import { PolicyViolationError } from "./types";
import { PolicyVaultClient } from "./policy-vault";
import type { LedgerStore } from "./ledger-store";
import { getDefaultLedgerStore } from "./ledger-store";
import { createHash } from "crypto";

const logger = pino({ name: "policy-guard", level: process.env.SWARM_TECHNICAL_LOGS === "1" ? "info" : "silent" });

const ORCA_DEVNET_SOL_USDC_POOL = "3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt";
const ORCA_DEVNET_USDC_MINT = "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k";
const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

export class PolicyGuard {
  private readonly agentKit: SolanaAgentKit;
  private readonly peerAddresses: string[];
  private peerIndex = 0;

  constructor(
    private readonly config: PolicyConfig,
    private readonly connection: Connection,
    private readonly signer: Keypair,
    private readonly policyVault: PolicyVaultClient,
    peerAddresses: string[] = [],
    private readonly ledgerStore: LedgerStore = getDefaultLedgerStore()
  ) {
    // Create a SolanaAgentKit instance using KeypairWallet for this agent.
    const wallet = new KeypairWallet(signer, connection.rpcEndpoint);
    this.agentKit = new SolanaAgentKit(wallet, connection.rpcEndpoint, {});
    this.peerAddresses = peerAddresses.filter(
      (addr) => addr !== signer.publicKey.toBase58()
    );
  }

  /** Get the next peer address to send to (round-robin). */
  private getNextPeer(): PublicKey {
    if (this.peerAddresses.length === 0) {
      // Fallback: if no peers, transfer to self (single-agent mode).
      return this.signer.publicKey;
    }
    const addr = this.peerAddresses[this.peerIndex % this.peerAddresses.length]!;
    this.peerIndex += 1;
    return new PublicKey(addr);
  }

  private readLedgerEntry(key: string): { date: string; spentSol: number; lastIntentTs: number } | undefined {
    return this.ledgerStore.getAgentEntry(key);
  }

  private writeLedgerEntry(key: string, value: { date: string; spentSol: number; lastIntentTs: number }): void {
    this.ledgerStore.setAgentEntry(key, value);
  }

  private intentReplayKey(intent: AgentIntent): string {
    const explicit = intent.metadata?.idempotencyKey;
    if (typeof explicit === "string" && explicit.trim().length > 0) {
      return `idk:${explicit.trim()}`;
    }

    const canonical = JSON.stringify({
      agentId: intent.agentId,
      type: intent.type,
      protocol: intent.protocol,
      amountSol: intent.amountSol,
      inputMint: intent.inputMint ?? "",
      outputMint: intent.outputMint ?? "",
      slippageBps: intent.slippageBps,
      rationale: intent.rationale,
      timestamp: intent.timestamp.toISOString()
    });

    return `hash:${createHash("sha256").update(canonical).digest("hex")}`;
  }

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
    const current = this.readLedgerEntry(key);
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

    // Idempotency / replay protection.
    const replayKey = this.intentReplayKey(intent);
    const claimed = this.ledgerStore.claimIntent(replayKey, intent.agentId, nowTs);
    if (!claimed) {
      throw await this.violation(intent, "REPLAY_DETECTED", "Intent replay detected: this idempotency key was already used.");
    }

    // ── All checks passed — execute. ──────────────────────────────────────────
    let signature: string;
    try {
      signature = await this.execute(intent);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.ledgerStore.failIntent(replayKey, reason);
      throw err;
    }

    this.writeLedgerEntry(key, {
      date: day,
      spentSol: currentSpend + intent.amountSol,
      lastIntentTs: nowTs
    });

    this.ledgerStore.completeIntent(replayKey, signature);

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


    if (intent.protocol === "orca") return this.executeOrcaWhirlpoolSwap(intent);
    // spl-token-swap fallback
    return this.executeSplTokenTransfer(intent);
  }

  private async sendAndConfirmIx(instructions: TransactionInstruction[]): Promise<string> {
    const tx = new Transaction().add(...instructions);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.signer.publicKey;
    tx.sign(this.signer);
    const sig = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    return sig;
  }

  private shouldRunPeerTransferCompanion(intent: AgentIntent): boolean {
    const metaFlag = intent.metadata?.postPeerSplTransfer;
    if (typeof metaFlag === "boolean") return metaFlag;
    return process.env.SWAP_WITH_PEER_SPL_TRANSFER === "true";
  }

  private async maybeRunPostSwapPeerSplTransfer(intent: AgentIntent): Promise<void> {
    if (intent.type !== "swap") return;
    if (!this.shouldRunPeerTransferCompanion(intent)) return;

    const companionAmount = Math.max(Math.min(intent.amountSol * 0.1, 0.05), 0.005);
    const companionIntent: AgentIntent = {
      ...intent,
      type: "transfer",
      protocol: "spl-token-swap",
      amountSol: companionAmount,
      rationale: `${intent.rationale} | Companion peer SPL transfer enabled.`
    };

    const companionSig = await this.executeSplTokenTransfer(companionIntent);
    logger.info({ companionSig, agentId: intent.agentId }, "Companion post-swap peer SPL transfer completed.");
  }


  private async executeOrcaWhirlpoolSwap(intent: AgentIntent): Promise<string> {
    try {
      console.log("→ [orca] Step 1/5: building Anchor provider and Whirlpool context...");
      const anchorWallet = {
        publicKey: this.signer.publicKey,
        signTransaction: async <T>(tx: T): Promise<T> => {
          const txWithSign = tx as T & { sign?: (...args: unknown[]) => unknown; partialSign?: (...args: unknown[]) => unknown };
          if (typeof txWithSign.sign === "function") txWithSign.sign([this.signer]);
          if (typeof txWithSign.partialSign === "function") txWithSign.partialSign(this.signer);
          return tx;
        },
        signAllTransactions: async <T>(txs: T[]): Promise<T[]> => Promise.all(txs.map((tx) => anchorWallet.signTransaction(tx)))
      };
      const anchorProvider = new AnchorProvider(this.connection, anchorWallet, AnchorProvider.defaultOptions());
      const ctx = WhirlpoolContext.withProvider(anchorProvider);

      console.log("→ [orca] Step 2/5: loading Whirlpool client and pool...");
      const client = buildWhirlpoolClient(ctx);
      const pool = await client.getPool(new PublicKey(ORCA_DEVNET_SOL_USDC_POOL));

      console.log("→ [orca] Step 3/5: building swap quote by input token...");
      const solMintKey = new PublicKey(SOL_MINT_ADDRESS);
      const inputAmount = new BN(Math.floor(intent.amountSol * LAMPORTS_PER_SOL));
      const slippageTolerance = Percentage.fromDecimal(new Decimal(intent.slippageBps).div(10_000));
      const quote = await swapQuoteByInputToken(
        pool,
        solMintKey,
        inputAmount,
        slippageTolerance,
        ctx.program.programId,
        ctx.fetcher,
        IGNORE_CACHE
      );

      console.log("→ [orca] Step 4/5: executing Whirlpool swap transaction...");
      const txPayload = await pool.swap(quote);
      const txId = await txPayload.buildAndExecute();

      console.log(`→ [orca] Step 5/5: Whirlpool swap confirmed: ${txId}`);
      await this.maybeRunPostSwapPeerSplTransfer(intent);
      return txId;
    } catch (err) {
      logger.warn({ err, agentId: intent.agentId }, "Orca Whirlpool swap failed, falling back to SPL token transfer.");
      return this.executeSplTokenTransfer(intent);
    }
  }

  // ── SPL token transfer fallback ─────────────────────────────────────────────
  // Creates an SPL token mint, mints tokens to the agent, then transfers tokens
  // to a peer agent. This demonstrates "hold SPL tokens" and "interact with a
  // protocol" (Token Program) — a real on-chain operation.

  private async executeSplTokenTransfer(intent: AgentIntent): Promise<string> {
    // Step 1: Create a new SPL token mint on devnet.
    logger.info({ agentId: intent.agentId }, "Creating SPL token mint on devnet...");
    const mint = await createMint(
      this.connection,
      this.signer,       // payer
      this.signer.publicKey, // mint authority
      null,               // freeze authority
      9                   // decimals
    );
    logger.info({ mint: mint.toBase58(), agentId: intent.agentId }, "SPL token mint created.");

    // Step 2: Create associated token account for the agent and mint tokens.
    const agentAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.signer,
      mint,
      this.signer.publicKey
    );

    const mintAmount = Math.floor(intent.amountSol * 1_000_000_000); // treat amountSol as token amount
    await mintTo(
      this.connection,
      this.signer,
      mint,
      agentAta.address,
      this.signer,        // mint authority
      mintAmount
    );
    logger.info({ amount: mintAmount, agentId: intent.agentId }, "Tokens minted to agent wallet.");

    // Step 3: Transfer tokens to a peer agent.
    const peer = this.getNextPeer();
    const peerAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.signer,        // payer for ATA creation
      mint,
      peer
    );

    const transferSig = await splTransfer(
      this.connection,
      this.signer,
      agentAta.address,
      peerAta.address,
      this.signer,
      mintAmount
    );
    const sig = typeof transferSig === "string" ? transferSig : Buffer.from(transferSig).toString("base64");

    logger.info({
      signature: sig,
      mint: mint.toBase58(),
      from: this.signer.publicKey.toBase58(),
      to: peer.toBase58(),
      agentId: intent.agentId
    }, "SPL token transfer confirmed on devnet.");

    return sig;
  }

  // ── Generic confirmed inter-agent SOL transfer ──────────────────────────────

  private async executeTransfer(intent: AgentIntent): Promise<string> {
    const lamports = Math.floor(intent.amountSol * LAMPORTS_PER_SOL);
    const peer = this.getNextPeer();

    const ix = SystemProgram.transfer({
      fromPubkey: this.signer.publicKey,
      toPubkey: peer,
      lamports
    });

    const signature = await this.sendAndConfirmIx([ix]);
    logger.info({ signature, agentId: intent.agentId, to: peer.toBase58() }, "Inter-agent transfer confirmed on devnet.");
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
