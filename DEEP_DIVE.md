# DEEP_DIVE.md — PolicyGuard Swarm Agentic Wallet

## Why this architecture exists

`policyguard-swarm-agentic-wallet` is designed to satisfy a difficult balance: autonomous behavior for an agentic system while maintaining strict key isolation and deterministic policy enforcement. In many wallet experiments, an LLM receives too much authority and effectively becomes a signer. That is exactly the anti-pattern this bounty tries to avoid. Here, the architecture treats AI as a planner and the wallet runtime as a constrained executor — powered by [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) for wallet execution. The result is a design where agents can still coordinate, trade, and rebalance on Solana devnet, but every action is gated by a hardened policy layer.

The project is Bun-native end-to-end. The execution model uses lightweight TypeScript modules, explicit interfaces, and a fail-fast security pipeline. Each agent gets its own `KeypairWallet` → `SolanaAgentKit` instance, and transactions are sent via `sendTx` with automatic compute budget management.

## High-level architecture

```mermaid
flowchart TD
  A[Agent Decision Engine\nScripted/Groq/Generic LLM] -->|Intent Only| B[PolicyGuard]
  B --> C{8-Step Validation}
  C -->|Pass| D[SolanaAgentKit Execution\nKeypairWallet + sendTx]
  C -->|Fail| E[PolicyViolationError + Reason]
  D --> F[Transaction Signature]
  E --> G[Rejected Intent]
  F --> H[PolicyVault Audit Logger]
  G --> H
  subgraph Funder Wallet
    FW[funder.json] -->|0.3 SOL each| S1
    FW -->|0.3 SOL each| S2
    FW -->|0.3 SOL each| S3
  end
  subgraph Swarm
    S1[Agent 1\nKeypairWallet + SolanaAgentKit]
    S2[Agent 2\nKeypairWallet + SolanaAgentKit]
    S3[Agent N\nKeypairWallet + SolanaAgentKit]
  end
  S1 -->|Peer Addresses| A
  S2 -->|Peer Addresses| A
  S3 -->|Peer Addresses| A
  subgraph "Execution Paths"
    J[Jupiter: Quote API + Inter-agent SOL Transfer]
    R[Raydium: SPL Token Mint + Inter-agent Token Transfer]
  end
  D --> J
  D --> R
```

Each swarm agent has its own wallet and its own PolicyGuard instance. The guard holds policy configuration, a daily spend ledger, cooldown timing state, and references to execution infrastructure. If an intent is rejected at any stage, execution is stopped immediately and a reason code is emitted.

## Wallet architecture details

### 1) Isolated keypairs + SolanaAgentKit

Every agent is provisioned through `Keypair.generate()` during a two-pass swarm spawn. The keypair is wrapped in a `KeypairWallet` from Solana Agent Kit, which is then used to create a per-agent `SolanaAgentKit` instance. This instance lives inside the agent's `PolicyGuard` — the decision engine never receives key material and cannot access signer methods.

### 2) Intent-driven behavior

The agent decision module outputs an `AgentIntent` object. This object includes protocol choice, amount, slippage, mint pair, and rationale. The schema is intentionally policy-readable. AI simulation can be upgraded independently (scripted logic, local model stubs, or other deterministic planners), but signing remains fixed behind PolicyGuard.

### 3) Automated signing path

After validation succeeds, PolicyGuard routes execution through `SolanaAgentKit`:

- **Jupiter path**: fetches a real quote from the Jupiter API (proving dApp connectivity with real price data), then executes a confirmed **inter-agent SOL transfer** to a peer agent via `sendTx`.
- **Raydium path**: verifies Raydium API reachability, then creates a new **SPL token mint** on devnet, mints tokens to the agent's associated token account, and **transfers SPL tokens to a peer agent's token account** — interacting with the Token Program.
- **Generic fallback**: inter-agent SOL transfer via `sendTx`.

All transactions use `sendTx` from Solana Agent Kit, which handles compute budget estimation and priority fees automatically.

### 4) Funder wallet distribution

Instead of relying on rate-limited devnet airdrops, agents are funded from a single **funder wallet** (`--funder=funder.json`). The funder wallet is created on first run and must be funded via the [Solana devnet faucet](https://faucet.solana.com/) before the swarm can execute. On subsequent runs, the swarm executor distributes 0.3 SOL to each agent via `SystemProgram.transfer`.

### 5) Peer-aware execution

The swarm executor uses a two-pass spawn: first all keypairs are generated, then all wallet addresses are collected and passed to each `PolicyGuard` constructor. This allows each agent to know its peers and execute real inter-agent transfers (round-robin) instead of meaningless self-transfers.

## PolicyGuard internals (exact 8-step validation)

Validation order matters and is intentionally static:

1. **Rationale quality check** — rejects empty or trivial rationale when reason strings are required.
2. **Protocol allowlist check** — only approved protocols (Jupiter/Raydium defaults).
3. **Mint allowlist check** — restricts tradable assets to known mints.
4. **Max transaction size check** — e.g., default `0.5 SOL` cap.
5. **Daily cumulative exposure check** — e.g., default `5 SOL` cap.
6. **Slippage limit check** — e.g., default `100 bps`.
7. **Cooldown check** — blocks rapid-fire intent bursts by the same agent.
8. **Network + reserve check** — enforces devnet endpoint and minimum reserve floor.

This ordering provides fast rejection of unsafe requests and avoids unnecessary RPC or simulation work when an earlier control already fails.

## Security considerations

### Private key non-exposure

The most important requirement is that an AI system cannot touch keys. In this design:

- AI modules only construct intent payloads.
- Keys are held in isolated wallet runtime objects.
- PolicyGuard owns execution and signing orchestration.
- No prompt-processing module receives secret key bytes.

### Deterministic rejection reasons

Policy rejections are explicit, with machine-parseable codes (`MAX_TX_EXCEEDED`, `SLIPPAGE_TOO_HIGH`, etc.) and human-readable reasoning. This enables auditability, debugging, and compliance reporting.

### On-chain audit trail concept

`PolicyVaultClient` demonstrates an Anchor-coupled logging client and PDA derivation for audit state. In production, this would serialize full policy decisions to a dedicated account model. Even in placeholder mode, the API boundary is present: every approved/rejected action can be written to an immutable ledger-oriented sink.

### Attack simulation readiness

The CLI includes an `attack-test` command to model malicious behavior (oversized transfers, weak rationale). This helps teams show security posture in demos and bounty reviews.

## Swarm scalability model

The swarm executor demonstrates horizontal scale with coordinated behavior:

- One command can spawn 6+ agents.
- Each agent has an isolated wallet and spend ledger.
- Role assignment distributes strategy responsibilities (maker, arbiter, liquidity, risk, hedge, executor).
- Event-driven coordination publishes intent lifecycle events (`intent.created`, `intent.executed`, `intent.rejected`).

This pattern is intentionally simple but extensible. You can introduce dynamic role reassignment, leader election, or probabilistic strategy overlays without changing key isolation or policy boundaries.

## Why this beats basic keypair wallets

A basic keypair wallet gives signing capability but not governance. In contrast, PolicyGuard adds a programmable risk envelope. The system can still sign autonomously, but only after passing deterministic controls. That combination is what an enterprise or bounty reviewer wants to see: autonomy with guardrails.

Compared to a plain wallet demo:

- **Better safety:** amount caps, slippage controls, cooldowns, reserve checks.
- **Better observability:** audit logging interface and reasoned rejection semantics.
- **Better scale:** multi-agent orchestration with independent risk compartments.
- **Better modularity:** AI planning separated from signing and policy modules.

## Interaction model for AI frameworks

The project includes `SKILLS.md` so external agent frameworks (OpenClaw, Eliza, LangChain-based orchestrators, and custom planners) can consume a structured capability map. Each skill has:

- canonical name,
- concise intent,
- typed input example,
- typed output example.

This enables predictable tool invocation and avoids free-form prompting for sensitive operations. A framework can first call `check_policy`, then `execute_intent`, then `policy_audit_log`, creating a clear and testable transaction lifecycle.

## Devnet execution walkthrough

1. Generate funder wallet (`--funder=funder.json` on first run).
2. Fund funder wallet via Solana devnet faucet.
3. Run swarm — funder distributes 0.3 SOL to each agent via `SystemProgram.transfer`.
4. AI engine (Groq/scripted) generates intents.
5. Validate intents through PolicyGuard 8-step sequence.
6. For Jupiter: fetch real quote from Jupiter API → inter-agent SOL transfer via `sendTx`.
7. For Raydium: verify API reachability → create SPL token mint → mint tokens → inter-agent SPL token transfer.
8. Record outcomes to audit log client.
9. Review event stream and rejection reasons.

## Live devnet test results

### Swarm execution (3 agents, Groq engine)

```
Engine: GroqDecisionEngine | Agents: 3 | RPC: devnet (default)
Funding: 0.3 SOL per agent from funder wallet

[agent-3] 📋 jupiter 0.04◎
  → Jupiter quote received (outAmount: 3440057)
  → Inter-agent SOL transfer to peer 4uzFyqnCfhFuWLVXF5AuYWNAUoyLdoTrbKbgEiZQe2X5
[agent-3] ✅ Signature: 2QDE5Cfq5QFDybTZAK9QSpQUH4p9GsogbtfTpgdFgPbwHiJJe9uo4ZBLXhGN4u44jNxnzoCDQXWpWVX7FSmyae7G

[agent-1] 📋 raydium 0.2◎
  → Raydium API reachable
  → SPL token mint created: EctQJhFFs2gy7fk2A4huMjB4oYriJKeVB9szsmrbacmP
  → 200M tokens minted to agent wallet
  → SPL tokens transferred to peer 8iu4p68yehR1CJ59YwAdMmiBZcv1Q3PT7K7TBhBASPaE
[agent-1] ✅ Signature: 4PSMtHqU4kAuA65EKmtUytPfLXBKin5kh27Vr7JpHTLpkbyBs4pfZeiTun65XbDuGxp8sbSpT2iEGG4Dk8o6DWMz

Swarm complete — 2 executed, 1 rejected out of 3 agents.
```

Verify on [Solana Explorer (devnet)](https://explorer.solana.com/?cluster=devnet):
- [agent-3 Jupiter SOL transfer](https://explorer.solana.com/tx/2QDE5Cfq5QFDybTZAK9QSpQUH4p9GsogbtfTpgdFgPbwHiJJe9uo4ZBLXhGN4u44jNxnzoCDQXWpWVX7FSmyae7G?cluster=devnet)
- [agent-1 SPL token mint + transfer](https://explorer.solana.com/tx/4PSMtHqU4kAuA65EKmtUytPfLXBKin5kh27Vr7JpHTLpkbyBs4pfZeiTun65XbDuGxp8sbSpT2iEGG4Dk8o6DWMz?cluster=devnet)
- [SPL token mint](https://explorer.solana.com/address/EctQJhFFs2gy7fk2A4huMjB4oYriJKeVB9szsmrbacmP?cluster=devnet)

### Attack simulation (malicious intent blocked)

```
Simulating malicious intent (amountSol=10, rationale='hack')...
✅ Rejected as expected: Policy violation [RATIONALE_REQUIRED]: Intent rationale must be present and meaningful.
```

The attacker's intent is rejected at PolicyGuard's first validation step before any signing or execution can occur.

## Submission-readiness checklist rationale

This implementation is aligned to the stated bounty criteria:

- Agentic wallet behavior is real, automated, and policy-governed.
- Security controls are explicit and centrally enforced.
- Swarm architecture demonstrates scalability and isolation.
- Documentation is complete for evaluators and open-source contributors.
- Tooling and scripts are Bun-native for reproducible setup.

## Future hardening ideas

- Add durable persistent ledger storage for spend/cooldown state.
- Integrate full Jupiter swap execution on mainnet (ALTs available).
- Integrate real Raydium LP pool initialization and deposit flows.
- Leverage Solana Agent Kit plugins (token, DeFi, NFT) for richer protocol interactions.
- Add cryptographic policy receipts signed by a policy authority key.
- Add multi-party override workflows for emergency policy edits.
- Add deterministic simulation mode to compare planned vs. executed routes.

This project is intentionally engineered as a practical, inspectable foundation: secure by default, scalable by structure, and compatible with agent-first orchestration without exposing private keys.
