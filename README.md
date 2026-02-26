# policyguard-swarm-agentic-wallet

A Bun-native Solana devnet prototype for the Superteam Nigeria **Agentic Wallet** bounty. This project demonstrates secure automated signing, policy-gated execution, and a scalable multi-agent swarm where each agent owns an isolated wallet — powered by [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) for wallet execution.

## 1-command setup (Bun)

```bash
bun install && bun run src/main.ts run-swarm --agents=2 --engine=groq --funder=funder.json
```

## Commands

```bash
bun run src/main.ts create-wallet
bun run src/main.ts run-swarm --agents=2 --engine=groq --funder=funder.json
bun run src/main.ts attack-test
bun run example
bun run test
bun run build
```

## How to run (step-by-step)

1. Install dependencies:
   ```bash
   bun install
   ```
2. Generate a funder wallet (first run creates `funder.json` and prints the public key):
   ```bash
   bun run src/main.ts run-swarm --agents=2 --engine=groq --funder=funder.json
   ```
3. Fund the funder wallet via the [Solana devnet faucet](https://faucet.solana.com/) or CLI:
   ```bash
   solana airdrop 5 <FUNDER_PUBLIC_KEY> --url devnet
   ```
4. Run the swarm again (the funder wallet distributes 0.3 SOL to each agent automatically):
   ```bash
   bun run src/main.ts run-swarm --agents=2 --engine=groq --funder=funder.json
   ```
5. Generate a standalone isolated wallet:
   ```bash
   bun run src/main.ts create-wallet
   ```
6. Run the malicious-intent safety simulation:
   ```bash
   bun run src/main.ts attack-test
   ```

RPC override options (for devnet rate limits):
- CLI flag: `--rpc=https://your-rpc`
- Environment variable fallback:
  ```bash
  export SOLANA_RPC_URL="https://your-rpc"
  bun run src/main.ts run-swarm --agents=2 --funder=funder.json
  ```

## AI Agent Integration

The swarm supports three decision engine modes selectable via `--engine` flag or `AGENT_ENGINE` env var.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SOLANA_RPC_URL` | No | Custom devnet RPC (overrides default) |
| `AGENT_ENGINE` | No | `scripted` (default) \| `groq` \| `openai` |
| `GROQ_API_KEY` | For Groq | Groq developer key — [console.groq.com](https://console.groq.com) |
| `OPENAI_API_KEY` | For OpenAI | OpenAI API key — [platform.openai.com](https://platform.openai.com) |

### Running with Groq (llama-3.1-8b-instant)

```bash
export GROQ_API_KEY="your_groq_key"
bun run src/main.ts run-swarm --agents=2 --engine=groq --funder=funder.json
```

### Running with OpenAI (gpt-4o-mini)

```bash
export OPENAI_API_KEY="your_openai_key"
bun run src/main.ts run-swarm --agents=2 --engine=openai --funder=funder.json
```

### Running the full example (all three modes)

```bash
# No keys = scripted only. Set any/both keys to enable AI sections.
GROQ_API_KEY=gsk_... OPENAI_API_KEY=sk-... bun run example
```

### How AI engines work

Both `GroqDecisionEngine` and `OpenAIDecisionEngine` (in `src/ai-engines/`) implement `IAgentDecisionEngine`. They send a **constrained system prompt** that forces the model to output only a JSON `AgentIntent` object — no free-form prose, no key access. Every LLM response is field-validated before entering PolicyGuard. If parsing fails, a safe scripted fallback is used automatically.

```ts
import { GroqDecisionEngine } from "./src/agent-logic";

const engine = new GroqDecisionEngine();              // reads GROQ_API_KEY
const swarm  = new SwarmExecutor(undefined, engine);  // engine injected here
swarm.spawnAgents(6);
await swarm.runCoordinatedYieldStrategy();
```

### Plugging in your own AI engine

Implement `IAgentDecisionEngine` from `src/types.ts` and inject it into `SwarmExecutor`:

```ts
import type { AgentIntent, IAgentDecisionEngine } from "./src/types";

export class MyEngine implements IAgentDecisionEngine {
  async buildIntent(input: {
    agentId: string;
    marketBias: "bullish" | "bearish" | "neutral";
    protocolPreference: "jupiter" | "raydium";
  }): Promise<AgentIntent> {
    // Call your LLM / rules engine here.
    // NEVER receive or return keypairs or secret bytes.
    return { agentId: input.agentId, type: "swap", protocol: "jupiter",
             amountSol: 0.1, slippageBps: 50, rationale: "My engine rationale.", timestamp: new Date(),
             inputMint: "So11111111111111111111111111111111111111112",
             outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
  }
}
```

## Winning-criteria status (current revision)

This revision is designed to satisfy the bounty judging criteria end-to-end:

- ✅ **Functional autonomous wallet:** programmatic wallet creation via `Keypair.generate()` → `KeypairWallet` → `SolanaAgentKit`, automated execution path, funder-based agent funding, and CLI demo commands.
- ✅ **Security / key management:** AI planners only emit intents; keys remain isolated in runtime signer objects under `PolicyGuard`.
- ✅ **Protocol interaction proof:** Jupiter quote API verification + **real inter-agent SOL transfers**; Raydium API check + **SPL token mint creation, minting, and inter-agent token transfers** via the Token Program.
- ✅ **Hold SOL and SPL tokens:** Agents hold SOL from funder, create SPL token mints, mint tokens, and transfer them to peer agents.
- ✅ **Documentation + deep dive:** `README.md`, `DEEP_DIVE.md`, and `SKILLS.md` are included with setup and architecture details.
- ✅ **Scalability:** one-command swarm run with independent agents.

Notes:
- Agents are funded via a centralized **funder wallet** (`--funder=funder.json`) that distributes 0.3 SOL to each agent via `SystemProgram.transfer`.
- **Jupiter path**: fetches a real quote from Jupiter API, then transfers SOL to a **peer agent** using `sendTx` from Solana Agent Kit.
- **Raydium path**: creates an **SPL token mint**, mints tokens to the agent, then transfers **SPL tokens to a peer agent** — proving real protocol interaction with the Token Program.
- `PolicyVaultClient` defaults to deterministic dry-run logging for local reliability. Set `POLICY_VAULT_ONCHAIN=true` to force on-chain logging attempts.
- `attack-test` executes a malicious intent through `PolicyGuard` and prints the actual rejection result.

## Architecture overview

- `src/agent-logic.ts`: AI decision engines (scripted, Groq, generic LLM) that only produce intents — no key access.
- `src/policy-guard.ts`: Security gate with 8 fail-fast validations + execution via `SolanaAgentKit` / `sendTx`.
- `src/policy-vault.ts`: Anchor-powered on-chain audit logger placeholder with PDA derivation.
- `src/swarm-executor.ts`: Two-pass agent spawner with peer address distribution and event-driven orchestration.
- `src/main.ts`: CLI entrypoint for wallet creation, swarm run, funder wallet management, and attack simulation.

## How this meets every bounty requirement

1. **Working agentic wallet**
   - Programmatic wallet creation through `Keypair.generate()` → `KeypairWallet` → `SolanaAgentKit`.
   - Automated signing handled via `sendTx` from Solana Agent Kit, outside AI intent generation.
   - SOL held and transferred between agents; SPL tokens created, minted, and transferred.
   - Jupiter quote verification + confirmed inter-agent SOL transfer.
   - Raydium API check + SPL token mint creation + inter-agent SPL token transfer.
2. **PolicyGuard security layer**
   - Private keys never passed to AI decision engines.
   - Configurable policy schema (`zod`) with strict defaults.
   - Rejection is fail-fast with explicit reason codes and audit logging.
3. **Swarm of independent agents**
   - Two-pass `spawnAgents(count)` creates isolated keypairs, then builds PolicyGuards with full peer address list.
   - Agents are funded from a single funder wallet via `SystemProgram.transfer`.
   - Each agent has its own `SolanaAgentKit` instance wrapping a `KeypairWallet`.
4. **Separation of responsibilities**
   - Agent logic isolated from wallet signing and policy enforcement modules.
5. **SKILLS.md with 25+ skills**
   - Includes actionable skills with structured input/output examples.
6. **Open-source ready README**
   - One-command Bun setup + run instructions + security and architecture explanation.
7. **Working prototype on devnet**
   - Uses Solana devnet endpoint with funder wallet distribution workflow.
8. **Deep-dive documentation**
   - Full DEEP_DIVE.md plus architecture/security/scaling notes in README.
9. **Scalability demonstration**
   - One command runs coordinated strategy across multiple agents.
10. **Safe key management + automated signing + AI simulation**
    - Intent-only AI path; signing isolated in PolicyGuard via SolanaAgentKit execution path.

## Security deep-dive (summary)

- The AI layer produces intents only; it never receives private key references.
- PolicyGuard applies 8 ordered validations:
  1. Rationale requirement.
  2. Protocol allowlist.
  3. Mint allowlist.
  4. Max SOL per transaction.
  5. Daily SOL cap.
  6. Slippage cap.
  7. Cooldown window.
  8. Devnet-only + reserve floor.
- Every outcome is eligible for audit trail logging in PolicyVault.
- Rejections return explicit violation reason codes.

## Scalability section

- Run `bun run src/main.ts run-swarm --agents=3 --engine=groq --funder=funder.json`.
- Each agent receives:
  - unique wallet keypair → `KeypairWallet` → `SolanaAgentKit` instance,
  - role assignment,
  - dedicated PolicyGuard with peer address awareness,
  - independent spend ledger.
- Event bus tracks `intent.created`, `intent.executed`, and `intent.rejected`.

## Run on Solana devnet

1. Generate funder wallet: `bun run src/main.ts run-swarm --agents=2 --funder=funder.json`
2. Fund the funder wallet: `solana airdrop 5 <FUNDER_PUBLIC_KEY> --url devnet`
3. Start swarm strategy: `bun run src/main.ts run-swarm --agents=2 --engine=groq --funder=funder.json`
4. Execute attack simulation: `bun run src/main.ts attack-test`

## Live devnet test results

### Swarm execution (3 agents, Groq engine)

```
Engine: GroqDecisionEngine | Agents: 3 | RPC: devnet (default)
Checking balance and ensuring devnet funding from funder wallet for 3 agents...
  [agent-1] Transferring 0.3 SOL from funder... Funded ✅
  [agent-2] Transferring 0.3 SOL from funder... Funded ✅
  [agent-3] Transferring 0.3 SOL from funder... Funded ✅

[agent-3] 📋 jupiter 0.04◎
  → Jupiter quote received (outAmount: 3440057)
  → Inter-agent SOL transfer to peer 4uzFyqnCfhFuWLVXF5AuYWNAUoyLdoTrbKbgEiZQe2X5
[agent-3] ✅ Signature: 2QDE5Cfq5QFDybTZAK9QSpQUH4p9GsogbtfTpgdFgPbwHiJJe9uo4ZBLXhGN4u44jNxnzoCDQXWpWVX7FSmyae7G

[agent-1] 📋 raydium 0.2◎
  → Raydium API reachable
  → SPL token mint created: EctQJhFFs2gy7fk2A4huMjB4oYriJKeVB9szsmrbacmP
  → 200,000,000 tokens minted to agent wallet
  → SPL tokens transferred to peer 8iu4p68yehR1CJ59YwAdMmiBZcv1Q3PT7K7TBhBASPaE
[agent-1] ✅ Signature: 4PSMtHqU4kAuA65EKmtUytPfLXBKin5kh27Vr7JpHTLpkbyBs4pfZeiTun65XbDuGxp8sbSpT2iEGG4Dk8o6DWMz

Swarm complete — 2 executed, 1 rejected out of 3 agents.
```

Verify signatures on [Solana Explorer (devnet)](https://explorer.solana.com/?cluster=devnet):
- [agent-3 Jupiter SOL transfer](https://explorer.solana.com/tx/2QDE5Cfq5QFDybTZAK9QSpQUH4p9GsogbtfTpgdFgPbwHiJJe9uo4ZBLXhGN4u44jNxnzoCDQXWpWVX7FSmyae7G?cluster=devnet)
- [agent-1 SPL token mint + transfer](https://explorer.solana.com/tx/4PSMtHqU4kAuA65EKmtUytPfLXBKin5kh27Vr7JpHTLpkbyBs4pfZeiTun65XbDuGxp8sbSpT2iEGG4Dk8o6DWMz?cluster=devnet)
- [SPL token mint address](https://explorer.solana.com/address/EctQJhFFs2gy7fk2A4huMjB4oYriJKeVB9szsmrbacmP?cluster=devnet)

### Attack simulation (malicious intent rejection)

```
Simulating malicious intent (amountSol=10, rationale='hack')...
✅ Rejected as expected: Policy violation [RATIONALE_REQUIRED]: Intent rationale must be present and meaningful.
```

## Deep dive

For a full technical deep dive into the architecture, security model, Solana Agent Kit integration, PolicyGuard internals, and execution walkthrough, see **[DEEP_DIVE.md](./DEEP_DIVE.md)**.
