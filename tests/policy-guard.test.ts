import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { PolicyGuard } from "../src/policy-guard";
import { getDefaultPolicyConfig } from "../src/policy-config";
import type { AgentIntent, PolicyConfig } from "../src/types";
import { SwarmExecutor } from "../src/swarm-executor";
import type { LedgerEntry, LedgerStore } from "../src/ledger-store";

// Mock solana-agent-kit so PolicyGuard tests work with mock connections.
vi.mock("solana-agent-kit", () => ({
  KeypairWallet: vi.fn().mockImplementation((kp: any) => ({
    publicKey: kp.publicKey,
    signTransaction: vi.fn(async (tx: any) => tx),
    signAllTransactions: vi.fn(async (txs: any[]) => txs),
    signAndSendTransaction: vi.fn(async () => ({ signature: "mockSig" })),
    signMessage: vi.fn(async () => new Uint8Array()),
  })),
  SolanaAgentKit: vi.fn().mockImplementation(() => ({
    connection: {},
    wallet: {},
    config: {},
    methods: {},
    actions: [],
  })),
  sendTx: vi.fn(async () => "mockTxSig"),
}));

const FAKE_BLOCKHASH = "11111111111111111111111111111111";

class MemoryLedgerStore implements LedgerStore {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly intents = new Map<string, { status: "pending" | "completed" | "failed"; reason?: string; signature?: string }>();

  getAgentEntry(agentId: string): LedgerEntry | undefined {
    return this.entries.get(agentId);
  }

  setAgentEntry(agentId: string, entry: LedgerEntry): void {
    this.entries.set(agentId, entry);
  }

  claimIntent(intentKey: string): boolean {
    if (this.intents.has(intentKey)) return false;
    this.intents.set(intentKey, { status: "pending" });
    return true;
  }

  completeIntent(intentKey: string, signature: string): void {
    this.intents.set(intentKey, { status: "completed", signature });
  }

  failIntent(intentKey: string, reason: string): void {
    this.intents.set(intentKey, { status: "failed", reason });
  }
}

function buildIntent(overrides: Partial<AgentIntent> = {}): AgentIntent {
  return {
    agentId: "agent-test",
    type: "swap",
    protocol: "orca",
    amountSol: 0.1,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    slippageBps: 50,
    rationale: "Valid strategy rationale for testing policy guard.",
    timestamp: new Date(),
    ...overrides
  };
}

function setupGuard(configOverride: Partial<PolicyConfig> = {}) {
  const config = { ...getDefaultPolicyConfig(), ...configOverride };
  const signer = Keypair.generate();
  const peer = Keypair.generate();
  const connection = {
    rpcEndpoint: "https://api.devnet.solana.com",
    getBalance: vi.fn(async () => 10_000_000_000),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 9_999_999 })),
    sendTransaction: vi.fn(async () => "txSig"),
    sendRawTransaction: vi.fn(async () => "rawSig"),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    getMinimumBalanceForRentExemption: vi.fn(async () => 0)
  } as never;
  const policyVault = { logAction: vi.fn(async () => "auditSig") } as never;
  const peerAddresses = [signer.publicKey.toBase58(), peer.publicKey.toBase58()];
  const ledgerStore = new MemoryLedgerStore();

  return {
    guard: new PolicyGuard(config, connection, signer, policyVault, peerAddresses, ledgerStore),
    config,
    signer,
    ledgerStore
  };
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
}

beforeEach(() => stubFetch());

describe("PolicyGuard — validation + idempotency", () => {
  it("rejects weak rationale (check 1)", async () => {
    const { guard } = setupGuard();
    await expect(
      guard.validateAndExecute(buildIntent({ rationale: "short" }))
    ).rejects.toThrow("RATIONALE_REQUIRED");
  });

  it("rejects blocked protocol (check 2)", async () => {
    const { guard } = setupGuard({ allowedProtocols: ["orca"] });
    await expect(
      guard.validateAndExecute(buildIntent({ protocol: "raydium", rationale: "valid rationale string here" }))
    ).rejects.toThrow("PROTOCOL_BLOCKED");
  });

  it("allows allowlisted protocol and resolves a signature", async () => {
    const { guard } = setupGuard();
    vi.spyOn(guard as never, "execute" as never).mockResolvedValue("mock-sig");
    await expect(
      guard.validateAndExecute(buildIntent({ protocol: "raydium", rationale: "valid raydium rationale string" }))
    ).resolves.toBeTypeOf("string");
  });

  it("rejects forbidden mint (check 3)", async () => {
    const { guard } = setupGuard();
    await expect(
      guard.validateAndExecute(buildIntent({ outputMint: "ForbiddenMint111111111111111111111111111111" }))
    ).rejects.toThrow("MINT_BLOCKED");
  });

  it("rejects per-tx amount ceiling (check 4)", async () => {
    const { guard } = setupGuard();
    await expect(
      guard.validateAndExecute(buildIntent({ amountSol: 1 }))
    ).rejects.toThrow("MAX_TX_EXCEEDED");
  });

  it("rejects daily cumulative ceiling (check 5)", async () => {
    const { guard } = setupGuard({ maxSolPerTransaction: 10, maxSolDaily: 5 });
    vi.spyOn(guard as never, "execute" as never).mockResolvedValue("mock-sig");
    await guard.validateAndExecute(buildIntent({ amountSol: 4.8, timestamp: new Date("2026-02-25T00:00:00Z") }));
    await expect(
      guard.validateAndExecute(buildIntent({ amountSol: 0.5, timestamp: new Date("2026-02-25T01:00:00Z") }))
    ).rejects.toThrow("MAX_DAILY_EXCEEDED");
  });

  it("rejects excessive slippage (check 6)", async () => {
    const { guard } = setupGuard();
    await expect(
      guard.validateAndExecute(buildIntent({ slippageBps: 999 }))
    ).rejects.toThrow("SLIPPAGE_TOO_HIGH");
  });

  it("rejects cooldown violation (check 7)", async () => {
    const { guard } = setupGuard();
    vi.spyOn(guard as never, "execute" as never).mockResolvedValue("mock-sig");
    const ts = new Date("2026-02-25T00:00:00Z");
    await guard.validateAndExecute(buildIntent({ timestamp: ts }));
    await expect(
      guard.validateAndExecute(buildIntent({ timestamp: new Date(ts.getTime() + 1000) }))
    ).rejects.toThrow("COOLDOWN_ACTIVE");
  });

  it("rejects blocked target address (check 8)", async () => {
    const blocked = "Bad111111111111111111111111111111111111111";
    const { guard } = setupGuard({ blockedAddresses: [blocked] });
    await expect(
      guard.validateAndExecute(buildIntent({ metadata: { targetAddress: blocked } }))
    ).rejects.toThrow("BLOCKED_ADDRESS");
  });

  it("rejects replayed intent idempotency key", async () => {
    const { guard } = setupGuard({ cooldownSeconds: 0 });
    vi.spyOn(guard as never, "execute" as never).mockResolvedValue("mock-sig");

    const first = buildIntent({
      timestamp: new Date("2026-02-25T00:00:00Z"),
      metadata: { idempotencyKey: "intent-123" }
    });

    const second = buildIntent({
      timestamp: new Date("2026-02-25T00:01:00Z"),
      metadata: { idempotencyKey: "intent-123" }
    });

    await expect(guard.validateAndExecute(first)).resolves.toBe("mock-sig");
    await expect(guard.validateAndExecute(second)).rejects.toThrow("REPLAY_DETECTED");
  });
});

describe("SwarmExecutor", () => {
  it("spawns exactly the requested number of agents", () => {
    const swarm = new SwarmExecutor("https://api.devnet.solana.com");
    expect(swarm.spawnAgents(6).length).toBe(6);
  });

  it("assigns all 6 distinct roles across a 6-agent swarm", () => {
    const swarm = new SwarmExecutor("https://api.devnet.solana.com");
    const roles = new Set(swarm.spawnAgents(6).map((a) => a.role));
    expect(roles.size).toBe(6);
  });

  it("assigns a unique wallet address to each agent", () => {
    const swarm = new SwarmExecutor("https://api.devnet.solana.com");
    const addresses = new Set(swarm.spawnAgents(6).map((a) => a.walletAddress));
    expect(addresses.size).toBe(6);
  });

  it("fires events on both typed topic and catch-all", async () => {
    const swarm = new SwarmExecutor("https://api.devnet.solana.com");
    swarm.spawnAgents(2);

    const typed: string[] = [];
    const catchAll: string[] = [];

    swarm.events.on("intent.created", (e) => typed.push(e.agentId));
    swarm.events.on("swarm.event", (e) => catchAll.push(e.agentId));

    const [firstAgent] = swarm.agents;
    if (firstAgent) {
      try {
        await firstAgent.processIntent({
          agentId: firstAgent.id,
          type: "swap",
          protocol: "orca",
          amountSol: 0.1,
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          slippageBps: 50,
          rationale: "test event routing check for the event bus",
          timestamp: new Date()
        });
      } catch {
        // acceptable
      }
    }

    expect(typed.length).toBeGreaterThan(0);
    expect(catchAll.length).toBeGreaterThanOrEqual(typed.length);
  });
});
