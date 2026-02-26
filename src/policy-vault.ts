import { AnchorProvider, BN, Program, web3 } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { PolicyAuditRecord } from "./types";

const POLICY_VAULT_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

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

    const ix = web3.SystemProgram.transfer({
      fromPubkey: this.provider.publicKey,
      toPubkey: auditPda,
      lamports: 0
    });

    const tx = new web3.Transaction().add(ix);
    tx.recentBlockhash = (await this.provider.connection.getLatestBlockhash()).blockhash;
    tx.feePayer = this.provider.publicKey;

    return this.provider.sendAndConfirm(tx, [], {
      skipPreflight: true
    });
  }
}
