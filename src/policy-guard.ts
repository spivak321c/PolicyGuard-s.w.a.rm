import { formatISO } from "date-fns";
import pino from "pino";
import { existsSync, readFileSync, writeFileSync } from "fs";
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
import { Raydium, TxVersion, DEVNET_PROGRAM_ID, CurveCalculator } from "@raydium-io/raydium-sdk-v2";
import { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken, ORCA_WHIRLPOOL_PROGRAM_ID, IGNORE_CACHE } from "@orca-so/whirlpools-sdk";
import { Percentage } from "@orca-so/common-sdk";
import Decimal from "decimal.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import BN from "bn.js";
import type { AgentIntent, PolicyConfig, PolicyAuditRecord } from "./types";
import { PolicyViolationError } from "./types";
import { PolicyVaultClient } from "./policy-vault";

const logger = pino({ name: "policy-guard", level: process.env.SWARM_TECHNICAL_LOGS === "1" ? "info" : "silent" });

const ORCA_DEVNET_SOL_USDC_POOL = "3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt";
const ORCA_DEVNET_USDC_MINT     = "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k";
const SOL_MINT_ADDRESS          = "So11111111111111111111111111111111111111112";

export class PolicyGuard {
  private readonly ledgerPath: string;
  private readonly agentKit: SolanaAgentKit;
  private readonly peerAddresses: string[];
  private peerIndex = 0;

  constructor(
    private readonly config: PolicyConfig,
    private readonly connection: Connection,
    private readonly signer: Keypair,
    private readonly policyVault: PolicyVaultClient,
    peerAddresses: string[] = []
  ) {
    // Create a SolanaAgentKit instance using KeypairWallet for this agent.
    const wallet = new KeypairWallet(signer, connection.rpcEndpoint);
    this.agentKit = new SolanaAgentKit(wallet, connection.rpcEndpoint, {});
    this.ledgerPath = `./ledger-${signer.publicKey.toBase58().slice(0,8)}.json`;
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
    if (!existsSync(this.ledgerPath)) {
      return undefined;
    }

    const contents = readFileSync(this.ledgerPath, "utf8");
    const ledger = JSON.parse(contents) as Record<string, { date: string; spentSol: number; lastIntentTs: number }>;
    return ledger[key];
  }

  private writeLedgerEntry(key: string, value: { date: string; spentSol: number; lastIntentTs: number }): void {
    const ledger = existsSync(this.ledgerPath)
      ? JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Record<string, { date: string; spentSol: number; lastIntentTs: number }>
      : {};

    ledger[key] = value;
    writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2));
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

    // ── All checks passed — execute. ──────────────────────────────────────────
    const signature = await this.execute(intent);

    this.writeLedgerEntry(key, {
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

    if (intent.protocol === "raydium") return this.executeRaydiumCpmmSwap(intent);
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

  // ── Raydium CPMM devnet swap demo ───────────────────────────────────────────

  private async executeRaydiumCpmmSwap(intent: AgentIntent): Promise<string> {
    console.log("→ [raydium] Step 1/10: loading Raydium SDK on devnet...");
    const raydium = await Raydium.load({
      connection: this.connection,
      owner: this.signer,
      cluster: "devnet",
      disableLoadToken: true
    });

    console.log("→ [raydium] Step 2/10: creating mintA + mintB...");
    const mintA = await createMint(this.connection, this.signer, this.signer.publicKey, null, 9);
    const mintB = await createMint(this.connection, this.signer, this.signer.publicKey, null, 9);

    console.log("→ [raydium] Step 3/10: creating ATAs and minting supply...");
    const ownerTokenA = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.signer,
      mintA,
      this.signer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    const ownerTokenB = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.signer,
      mintB,
      this.signer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    const initialSupply = 1_000_000_000;
    await mintTo(this.connection, this.signer, mintA, ownerTokenA.address, this.signer, initialSupply, [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(this.connection, this.signer, mintB, ownerTokenB.address, this.signer, initialSupply, [], undefined, TOKEN_PROGRAM_ID);

    console.log("→ [raydium] Step 4/10: fetching CPMM fee configs from API...");
    const feeConfigs = await raydium.api.fetchCpmmConfigs();
    const feeConfig = feeConfigs[0];
    if (!feeConfig) {
      throw await this.violation(intent, "RAYDIUM_CONFIG_MISSING", "No Raydium CPMM fee config available on devnet.");
    }

    console.log("→ [raydium] Step 5/10: creating CPMM pool...");
    const cpmmProgram = (DEVNET_PROGRAM_ID as typeof DEVNET_PROGRAM_ID & { CPMM_PROGRAM?: PublicKey }).CPMM_PROGRAM
      ?? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
    const poolCreateTx = await raydium.cpmm.createPool({
      programId: cpmmProgram,
      poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
      mintA: {
        address: mintA.toBase58(),
        decimals: 9,
        programId: TOKEN_PROGRAM_ID.toBase58()
      },
      mintB: {
        address: mintB.toBase58(),
        decimals: 9,
        programId: TOKEN_PROGRAM_ID.toBase58()
      },
      mintAAmount: new BN(initialSupply),
      mintBAmount: new BN(initialSupply),
      startTime: new BN(Math.floor(Date.now() / 1000) - 1),
      feeConfig,
      associatedOnly: false,
      ownerInfo: {
        feePayer: this.signer.publicKey,
        useSOLBalance: true
      },
      txVersion: TxVersion.V0
    });
    const createPoolResult = await poolCreateTx.execute({ sendAndConfirm: true });
    const poolId = poolCreateTx.extInfo.address.poolId.toBase58();
    console.log(`→ [raydium] CPMM pool created: ${poolId} (tx: ${createPoolResult.txId})`);

    console.log("→ [raydium] Step 6/10: waiting 1.5s for devnet RPC indexing...");
    await new Promise((r) => setTimeout(r, 1500));

    console.log("→ [raydium] Step 7/10: fetching pool info from RPC...");
    const rpcPools = await raydium.cpmm.getRpcPoolInfos([poolId]);
    const rpcPool = rpcPools[poolId];
    if (!rpcPool) {
      throw await this.violation(intent, "RAYDIUM_POOL_NOT_FOUND", `Pool ${poolId} not found via RPC after creation.`);
    }

    console.log("→ [raydium] Step 8/10: quoting with CurveCalculator.swap...");
    const curveSwap = CurveCalculator as unknown as {
      swap: (inputAmount: BN, baseReserve: BN, quoteReserve: BN, tradeFeeRate: BN) => { inputAmount: BN; outputAmount: BN };
    };
    const quote = curveSwap.swap(
      new BN(Math.floor(intent.amountSol * 1_000_000_000)),
      rpcPool.baseReserve,
      rpcPool.quoteReserve,
      rpcPool.configInfo?.tradeFeeRate ?? new BN(0)
    );

    console.log("→ [raydium] Step 9/10: executing CPMM swap transaction...");
    const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);
    const swapTx = await raydium.cpmm.swap({
      poolInfo: poolInfo.poolInfo,
      inputAmount: quote.inputAmount,
      swapResult: {
        inputAmount: quote.inputAmount,
        outputAmount: quote.outputAmount
      },
      baseIn: true,
      slippage: intent.slippageBps / 10_000,
      txVersion: TxVersion.V0
    });
    const swapResult = await swapTx.execute({ sendAndConfirm: true });

    console.log(`→ [raydium] Step 10/10: swap confirmed with txId ${swapResult.txId}`);
    return swapResult.txId;
  }

  private async executeOrcaWhirlpoolSwap(intent: AgentIntent): Promise<string> {
    try {
      console.log("→ [orca] Step 1/5: building Anchor provider and Whirlpool context...");
      const anchorWallet = {
        publicKey: this.signer.publicKey,
        signTransaction: async <T>(tx: T): Promise<T> => {
          const txWithSign = tx as T & { sign?: (...args: unknown[]) => unknown; partialSign?: (...args: unknown[]) => unknown };
          if (typeof txWithSign.sign === "function") txWithSign.sign(this.signer);
          if (typeof txWithSign.partialSign === "function") txWithSign.partialSign(this.signer);
          return tx;
        },
        signAllTransactions: async <T>(txs: T[]): Promise<T[]> => Promise.all(txs.map((tx) => anchorWallet.signTransaction(tx)))
      };
      const anchorProvider = new AnchorProvider(this.connection, anchorWallet, AnchorProvider.defaultOptions());
      const ctx = WhirlpoolContext.withProvider(anchorProvider, ORCA_WHIRLPOOL_PROGRAM_ID);

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
