# policyguard-swarm-agentic-wallet

A Bun-native Solana **devnet prototype** for an agentic wallet swarm.

This project demonstrates:
- programmatic wallet creation,
- automated signing via per-agent wallet signers,
- policy-gated execution,
- multi-agent isolation and orchestration,
- real on-chain interaction paths on devnet (Orca Whirlpool swaps with safe SPL-token fallback).

> **Design principle:** AI engines produce intents only. They never receive private keys.

---

## Quick start (judge-friendly)

### 1) Install

```bash
bun install
```

### 2) Create (or reuse) a funder wallet

```bash
bun run src/main.ts run-swarm --agents=2 --engine=scripted --funder=funder.json
```

If `funder.json` does not exist, the command creates it and prints the funder address.

### 3) Fund the funder wallet on devnet

```bash
solana airdrop 5 <FUNDER_PUBLIC_KEY> --url devnet
```

### 4) Run a swarm

```bash
# Scripted engine (no API key required)
bun run src/main.ts run-swarm --agents=2 --engine=scripted --funder=funder.json

# Groq engine
bun run src/main.ts run-swarm --agents=2 --engine=groq --funder=funder.json

# Generic OpenAI-compatible engine
bun run src/main.ts run-swarm --agents=2 --engine=generic --funder=funder.json
# Persist/reuse agent wallets across runs
bun run src/main.ts run-swarm --agents=2 --agents-file=agents.json --engine=coordinator --coordinator=groq:planner,openai:reviewer --funder=funder.json
# Enable companion inter-agent SPL transfer after successful swaps
bun run src/main.ts run-swarm --agents=2 --engine=scripted --with-peer-transfer=true --funder=funder.json
```

### 5) Run attack simulation

```bash
bun run src/main.ts attack-test
```

---

## Why a funder wallet exists

Devnet faucet and RPC endpoints are heavily rate-limited. Instead of each agent requesting faucet SOL, this project uses one funded wallet (`--funder=funder.json`) that distributes SOL to all agents.

Current funding logic:
- if an agent is below `0.8 SOL`, transfer `0.6 SOL` from funder,
- otherwise skip funding.

This keeps runs deterministic and avoids faucet bottlenecks during demos.

---

## Commands

```bash
bun run src/main.ts create-wallet
bun run src/main.ts run-swarm --agents=2 --engine=scripted --funder=funder.json
bun run src/main.ts run-swarm --agents=2 --engine=groq --funder=funder.json
bun run src/main.ts run-swarm --agents=2 --engine=generic --funder=funder.json
# Persist/reuse agent wallets across runs
bun run src/main.ts run-swarm --agents=2 --agents-file=agents.json --engine=coordinator --coordinator=groq:planner,openai:reviewer --funder=funder.json
# Enable companion inter-agent SPL transfer after successful swaps
bun run src/main.ts run-swarm --agents=2 --engine=scripted --with-peer-transfer=true --funder=funder.json
bun run src/main.ts attack-test
bun run example
bun run test
bun run build
```

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SOLANA_RPC_URL` | No | Custom RPC endpoint (defaults to devnet URL from code) |
| `AGENT_ENGINE` | No | `scripted` (default) \| `groq` \| `generic` \| other registered engines |
| `GROQ_API_KEY` | Yes for `groq` | Groq API key |
| `LLM_ENDPOINT` | Yes for `generic` | OpenAI-compatible `/chat/completions` endpoint |
| `LLM_MODEL` | Yes for `generic` | Model id |
| `LLM_API_KEY` | Optional for `generic` | API key |
| `POLICY_VAULT_ONCHAIN` | Optional | `true` to attempt on-chain memo logging |
| `POLICY_LEDGER_SQLITE_PATH` | Optional | Override durable SQLite policy ledger path |

Examples:

```bash
# Scripted
export AGENT_ENGINE=scripted

# Groq
export AGENT_ENGINE=groq
export GROQ_API_KEY="your_groq_key"

# Generic
export AGENT_ENGINE=generic
export LLM_ENDPOINT="https://api.groq.com/openai/v1/chat/completions"
export LLM_MODEL="llama-3.1-8b-instant"
export LLM_API_KEY="your_key"
```

---

## Architecture at a glance

- `src/main.ts`
  - CLI entrypoint, funder-wallet handling, swarm execution, attack simulation.
- `src/swarm-executor.ts`
  - two-pass agent spawn,
  - per-agent role + isolated wallet,
  - event bus and concurrent orchestration,
  - funder-to-agent SOL distribution.
- `src/policy-guard.ts`
  - 8-step policy validation,
  - execution routing (`orca`, `spl-token-swap`),
  - real signer-based transaction submission,
  - policy audit calls.
- `src/agent-logic.ts` + `src/ai-engines/*`
  - scripted and LLM intent generation,
  - strict intent shaping for safety.
- `src/policy-vault.ts`
  - audit logging client (dry-run by default; optional on-chain memo mode).

---

## Autonomous wallet behavior

### Programmatic wallet creation

- Agent wallets are generated with `Keypair.generate()` in swarm spawning.
- Wallets are wrapped with `KeypairWallet`/signer contexts for execution.

### Automated signing

- `PolicyGuard.validateAndExecute()` enforces checks then executes transaction flows with signer-backed submission.

### Holding SOL and SPL tokens

- Agents hold SOL from funder transfers.
- SPL path creates a mint, mints to agent ATA, and transfers tokens to a peer ATA.

### Protocol interaction on devnet

Execution routing:
- `orca` → Orca Whirlpool flow (with fallback on error),
- `spl-token-swap` → SPL token mint/mintTo/transfer flow.

---

## Security model summary

The AI layer is **intent-only**.

`PolicyGuard` applies ordered checks before any signing:
1. rationale quality,
2. protocol allowlist,
3. mint allowlist,
4. max SOL per tx,
5. max SOL daily,
6. max slippage,
7. cooldown window,
8. devnet-only + blocked address + reserve floor.

Rejected intents return explicit reason codes (`PolicyViolationError`).

Durable safety features now included:
- policy spend/cooldown state is persisted in SQLite via a durable ledger adapter,
- intent replay is blocked using idempotency keys (`metadata.idempotencyKey`) or deterministic intent hashing fallback.

---

## Multi-agent scalability summary

- one command can spawn many agents (`--agents=n`),
- each agent has isolated signer + policy guard,
- event bus emits `intent.created`, `intent.executed`, `intent.rejected`, `coordination.note`,
- runs use `Promise.allSettled` so one rejection does not crash the whole swarm.

---

## Devnet evidence

You provided this devnet transaction evidence:
- https://explorer.solana.com/tx/gMF8S4N8aPULw6hkefgehKRcsnrZ2cgCkQKF2ftS9MDnriwcyUExWGCGUdYbA3PTUSugWc59mjsw7K8y5P4Rmms?cluster=devnet

---

## Documentation index

- Deep technical write-up: [`DEEP_DIVE.md`](./DEEP_DIVE.md)
- Agent-readable capabilities: [`SKILLS.md`](./SKILLS.md)



### CLI-only flags for reproducible runs

- `--agents-file=agents.json`: persist/reuse generated agent wallets across runs (avoids fresh wallets every run).
- `--with-peer-transfer=true`: after a successful swap, perform a companion inter-agent SPL token transfer.
