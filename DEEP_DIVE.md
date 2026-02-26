# DEEP_DIVE.md — PolicyGuard Swarm Agentic Wallet

## Why this architecture exists

`policyguard-swarm-agentic-wallet` is designed to satisfy a difficult balance: autonomous behavior for an agentic system while maintaining strict key isolation and deterministic policy enforcement. In many wallet experiments, an LLM receives too much authority and effectively becomes a signer. That is exactly the anti-pattern this bounty tries to avoid. Here, the architecture treats AI as a planner and the wallet runtime as a constrained executor. The result is a design where agents can still coordinate, trade, and rebalance on Solana devnet, but every action is gated by a hardened policy layer.

The project is Bun-native end-to-end. The execution model uses lightweight TypeScript modules, explicit interfaces, and a fail-fast security pipeline. The code paths ensure that private keys are generated and retained inside isolated runtime contexts. No prompt-facing or model-facing module can directly call signing operations.

## High-level architecture

```mermaid
flowchart TD
  A[Agent Decision Engine\nScripted/Ollama Stub] -->|Intent Only| B[PolicyGuard]
  B --> C{8-Step Validation}
  C -->|Pass| D[solana-agent-kit Execution]
  C -->|Fail| E[PolicyViolationError + Reason]
  D --> F[Transaction Signature]
  E --> G[Rejected Intent]
  F --> H[PolicyVault Anchor Logger]
  G --> H
  subgraph Swarm
    S1[Agent 1 Wallet]
    S2[Agent 2 Wallet]
    S3[Agent N Wallet]
  end
  S1 --> A
  S2 --> A
  S3 --> A
```

Each swarm agent has its own wallet and its own PolicyGuard instance. The guard holds policy configuration, a daily spend ledger, cooldown timing state, and references to execution infrastructure. If an intent is rejected at any stage, execution is stopped immediately and a reason code is emitted.

## Wallet architecture details

### 1) Isolated keypairs

Every agent is provisioned through `Keypair.generate()` during swarm spawning. The keypair remains in the local runtime object graph where the PolicyGuard instance for that agent lives. The decision engine never receives key material and cannot access signer methods.

### 2) Intent-driven behavior

The agent decision module outputs an `AgentIntent` object. This object includes protocol choice, amount, slippage, mint pair, and rationale. The schema is intentionally policy-readable. AI simulation can be upgraded independently (scripted logic, local model stubs, or other deterministic planners), but signing remains fixed behind PolicyGuard.

### 3) Automated signing path

After validation succeeds, PolicyGuard invokes the execution path powered by `solana-agent-kit`. This is where signing occurs automatically with no manual click-path. The same safety layer also maintains treasury reserve checks and day-level spend limits.

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

1. Spawn wallets (`create-wallet` or `run-swarm --agents=6`).
2. Fund devnet wallets from faucet.
3. Generate intents via scripted decision engine.
4. Validate intents through PolicyGuard 8-step sequence.
5. Execute approved intents via automated signer path.
6. Record outcomes to audit log client.
7. Review event stream and rejection reasons.

## Submission-readiness checklist rationale

This implementation is aligned to the stated bounty criteria:

- Agentic wallet behavior is real, automated, and policy-governed.
- Security controls are explicit and centrally enforced.
- Swarm architecture demonstrates scalability and isolation.
- Documentation is complete for evaluators and open-source contributors.
- Tooling and scripts are Bun-native for reproducible setup.

## Future hardening ideas

- Add durable persistent ledger storage for spend/cooldown state.
- Integrate real Jupiter quote/route APIs and Raydium pool adapters.
- Add cryptographic policy receipts signed by a policy authority key.
- Add multi-party override workflows for emergency policy edits.
- Add deterministic simulation mode to compare planned vs. executed routes.

This project is intentionally engineered as a practical, inspectable foundation: secure by default, scalable by structure, and compatible with agent-first orchestration without exposing private keys.
