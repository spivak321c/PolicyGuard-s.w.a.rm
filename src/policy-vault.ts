import { AnchorProvider, BN, Program, web3 } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createMemoInstruction } from "@solana/spl-memo";
import type { PolicyAuditRecord } from "./types";

const POLICY_VAULT_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export class PolicyVaultClient {
  constructor(private readonly provider: AnchorProvider) {}

  private deriveAuditPda(agentId: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("audit"), Buffer.from(agentId)],
      POLICY_VAULT_PROGRAM_ID
    );
  }

  async logAction(record: PolicyAuditRecord): Promise<string> {
    const [auditPda] = this.deriveAuditPda(record.agentId);
    void auditPda;

    // Placeholder metadata write; in production wire to Anchor account serialization.
    const _anchorStylePayload = {
      amountLamports: new BN(Math.floor(record.amountSol * web3.LAMPORTS_PER_SOL)),
      approved: record.approved,
      reason: record.reason,
      intentType: record.intentType,
      protocol: record.protocol,
      createdAtTs: new BN(Math.floor(record.timestamp.getTime() / 1000)),
      signature: record.signature ?? ""
    };

    // Keeping Program reference for explicit Anchor coupling.
    void Program;

    // Default to dry-run mode to keep local demos deterministic.
    if (process.env.POLICY_VAULT_ONCHAIN !== "true") {
      return `dryrun-${record.agentId}-${record.timestamp.getTime()}`;
    }

    const memoString = JSON.stringify({
      agentId: record.agentId,
      approved: record.approved,
      protocol: record.protocol,
      amountSol: record.amountSol,
      reason: record.reason,
      ts: record.timestamp.toISOString()
    });

    const ix = createMemoInstruction(memoString, [this.provider.publicKey]);

    const tx = new web3.Transaction().add(ix);
    tx.recentBlockhash = (await this.provider.connection.getLatestBlockhash()).blockhash;
    tx.feePayer = this.provider.publicKey;

    const signature = await this.provider.sendAndConfirm(tx, [], {
      skipPreflight: true
    });
    console.log(`→ [policy-vault] memo logged on-chain: ${signature}`);
    return signature;
  }
}
