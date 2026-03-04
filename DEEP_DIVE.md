# DEEP_DIVE.md — PolicyGuard Swarm Agentic Wallet (Code-Accurate)

## 1) What this prototype is

This repository is a **devnet prototype** of an autonomous multi-agent wallet system.

Core goals:
- each agent has its own wallet,
- AI produces intents (not signatures),
- policy checks gate all execution,
- approved intents are signed and sent automatically,
- multiple agents can run concurrently with isolated state.

This is intentionally a prototype architecture for bounty demonstration, not a production custody stack.

---

## 2) System architecture

### 2.1 High-level flow

1. `SwarmExecutor` spawns `n` agents with unique keypairs.
2. An engine (scripted or LLM-backed) builds an `AgentIntent`.
3. Agent submits intent to `PolicyGuard.validateAndExecute()`.
4. PolicyGuard applies 8 checks in fixed order.
5. If approved, PolicyGuard routes execution by protocol:
   - `orca`,
   - `spl-token-swap` fallback path.
6. Result is emitted on event bus and logged through `PolicyVaultClient`.

### 2.2 Separation of responsibilities

- **AI engines**: planning only (`buildIntent`), no key access.
- **PolicyGuard**: policy enforcement + execution authority.
- **Wallet/signer**: executes on-chain actions.
- **SwarmExecutor**: lifecycle/orchestration of many agents.

This separation is the key security primitive in the project.

---

## 3) Wallet model and signing

## 3.1 Wallet creation

Agents are created programmatically (`Keypair.generate()`) during swarm spawn. Each agent gets a unique wallet address and isolated signer context.

## 3.2 Automated signing

After policy approval, transactions are signed by agent signer objects in execution paths (`sendRawTransaction` confirmation pattern and protocol SDK execution methods).

There is no manual confirmation step in normal swarm execution.

## 3.3 Funding model (devnet practicalities)

A single `funder.json` wallet funds all agents. This exists because devnet faucet/RPC rate limits can break per-agent airdrop flows.

Current logic: if agent balance < `0.8 SOL`, funder transfers `0.6 SOL`.

---

## 4) Intent model and AI integration

`AgentIntent` includes:
- `protocol` (`orca | spl-token-swap`),
- `type`,
- `amountSol`,
- mint pair,
- `slippageBps`,
- rationale,
- timestamp.

AI engines (scripted, Groq, generic model registry engines) build these intents. Generic LLM mode constrains output to JSON schema-like fields and applies safe parsing/fallbacks.

Critical boundary: AI does not handle private keys.

---

## 5) PolicyGuard: 8-step validation pipeline

Validation order is deterministic and fail-fast:

1. Rationale quality check.
2. Protocol allowlist.
3. Mint allowlist.
4. Per-transaction amount cap.
5. Daily cumulative spend cap.
6. Slippage cap.
7. Cooldown enforcement.
8. Devnet-only + blocked address + reserve floor checks.

If any check fails, `PolicyViolationError` is thrown with explicit code and reason.

---

## 6) Execution paths on devnet

## 6.1 `orca`

- Attempts Orca Whirlpool swap flow using devnet pool/mint constants.
- If this fails, code falls back to SPL-token transfer path.

## 6.2 `spl-token-swap` (implemented fallback path)

- Create SPL mint,
- create source ATA,
- mint tokens to agent ATA,
- create peer ATA,
- transfer tokens to peer.

This path provides deterministic protocol-level on-chain activity even when external DEX flows are unstable on devnet.

---

## 7) Audit logging model

`PolicyVaultClient` receives approved/rejected action records.

Current behavior:
- default: deterministic dry-run audit IDs,
- optional mode: on-chain memo transaction when `POLICY_VAULT_ONCHAIN=true`.

So the audit API boundary exists now; a full Anchor account program can replace placeholder behavior later.

### 7.1 How a lightweight Anchor Policy Vault can be incorporated

A prototype-sized Anchor integration can stay intentionally small:

1. Deploy a single `policy_vault` program with one `log_action` instruction.
2. Use PDA records keyed by `(agent_id, intent_key)` for append-only audit entries.
3. Persist only core fields: `approved`, `protocol`, `amount_lamports`, `reason_code`, `intent_key`, `timestamp`, optional `signature`.
4. Keep the existing `PolicyVaultClient` interface and add a new `anchor` mode behind env flags.

This avoids heavyweight governance/admin flows while still giving immutable, queryable on-chain audit history for judging.

### 7.2 Useful extra features (optional, post-bounty hardening)

- Policy versioning field in each record to prove which policy set approved/rejected execution.
- Risk score snapshot field for AI-explained decisions.
- Batched log writes for high-agent runs.
- Event indexing hooks (off-chain indexer) for analytics dashboards.
- Emergency pause flag (multisig controlled) for rapid containment.

---

## 8) Multi-agent scalability characteristics

Current scalability strengths:
- Two-pass spawn ensures agents know peer addresses.
- Each agent has isolated signer and policy guard.
- Event bus provides intent lifecycle telemetry.
- `Promise.allSettled` prevents one failure from collapsing the whole run.

Prototype limitations (expected at this stage):
- policy spend/cooldown state now persists via SQLite ledger adapter,
- not designed yet for distributed multi-process consistency.

---

## 9) Security posture (prototype-appropriate)

What is strong now:
- Intent-only AI boundary.
- Deterministic policy gates before signing.
- Explicit rejection reason codes.
- Reserve/slippage/cooldown controls.

What is intentionally prototype-grade:
- local JSON funder key file,
- SQLite-backed local ledger state (durable, single-node),
- policy vault placeholder rather than full on-chain account schema.

These are normal prototype tradeoffs, but should be upgraded for production-like deployments.

---

## 10) Requirement mapping (bounty)

- **Create wallet programmatically**: Yes (`Keypair.generate()` agent provisioning).
- **Sign transactions automatically**: Yes (PolicyGuard execution with signer automation).
- **Hold SOL or SPL tokens**: Yes (funder SOL + SPL mint/mintTo/transfer path).
- **Interact with test dApp/protocol**: Yes (Orca Whirlpool execution attempts + SPL Token Program interaction path).
- **Deep dive included**: Yes (this file).
- **README + setup instructions**: Yes.
- **SKILLS.md for agents**: Yes.
- **Working prototype on devnet**: Yes, with provided explorer evidence.

---

## 11) Practical next upgrades (without changing prototype scope)

1. Add optional encrypted keyfile plugin (keep current default simple for demos).
2. Add optional durable ledger adapter plugin (SQLite/Postgres/Redis).
3. Add optional idempotency key field in intent metadata.
4. Add optional per-agent in-memory queue abstraction for stricter execution ordering.

These can be implemented as modular adapters to keep the prototype simple while enabling stronger judge confidence.

