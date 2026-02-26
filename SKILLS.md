# SKILLS.md — PolicyGuard Swarm Agentic Wallet

> **Purpose**: This file is designed for AI agents to read and understand the capabilities of this wallet system. Each skill maps directly to a real function or code path in the `src/` directory.

## System Overview

This is an autonomous multi-agent wallet system on Solana devnet. Each agent gets:
- An isolated `Keypair` → `KeypairWallet` → `SolanaAgentKit` instance
- A dedicated `PolicyGuard` that enforces 8 safety checks before any transaction
- Peer awareness — agents know each other's wallet addresses for inter-agent transfers

**Key constraint**: AI agents generate *intents only*. They never receive private keys or signing access. All signing is handled by `PolicyGuard` via `SolanaAgentKit`.

---

## Wallet Skills

```yaml
skills:
  - name: create_wallet
    description: Create an isolated Keypair wallet programmatically.
    code_path: src/main.ts → createWallet()
    input: {}
    output:
      publicKey: "Base58 public key string"
      note: "Keys are isolated in memory — never passed to AI engines"
    example_command: "bun run src/main.ts create-wallet"

  - name: create_funder_wallet
    description: Generate or load a funder wallet from a JSON file. On first run creates the wallet and prints its address for manual funding via devnet faucet.
    code_path: src/main.ts → loadFunderWallet()
    input:
      funder_path: "funder.json"
    output:
      publicKey: "Funder wallet Base58 address"
      keypair: "Loaded from JSON file"
    example_command: "bun run src/main.ts run-swarm --funder=funder.json"

  - name: fund_agent_from_funder
    description: Transfer 0.3 SOL from a funder wallet to an agent wallet via SystemProgram.transfer.
    code_path: src/swarm-executor.ts → ensureFunding()
    input:
      funder_wallet: "Keypair loaded from funder.json"
      agent_address: "Agent public key"
    output:
      signature: "Devnet transaction signature"
      balance: "Agent balance after funding (0.300 SOL)"
```

## Agent Spawning Skills

```yaml
skills:
  - name: spawn_agents
    description: Two-pass agent spawning. First generates all keypairs, then creates PolicyGuard instances with full peer address list. Each agent gets its own SolanaAgentKit instance.
    code_path: src/swarm-executor.ts → SwarmExecutor.spawnAgents()
    input:
      count: 2  # number of agents
    output:
      agents:
        - id: "agent-1"
          walletAddress: "Base58 address"
          role: "maker | arbiter | liquidity | risk | hedge | executor"
          status: "idle"
    roles_assigned: ["maker", "arbiter", "liquidity", "risk", "hedge", "executor"]

  - name: get_agent_status
    description: Check an agent's current state and role.
    code_path: src/types.ts → SwarmAgent interface
    fields:
      id: "agent-1"
      walletAddress: "Base58"
      role: "maker"
      status: "idle | planning | executing | paused"
      dailySpendSol: 0.0
```

## Intent Generation Skills (AI Layer)

```yaml
skills:
  - name: build_intent_scripted
    description: Generate a deterministic swap/LP intent without any API key. Used as default and fallback engine.
    code_path: src/agent-logic.ts → ScriptedDecisionEngine.buildIntent()
    input:
      agentId: "agent-1"
      marketBias: "bullish | bearish | neutral"
      protocolPreference: "jupiter | raydium"
    output:
      type: "swap | add-liquidity"
      protocol: "jupiter | raydium"
      amountSol: 0.4
      slippageBps: 80
      rationale: "Scripted strategy selected jupiter for bullish conditions."
      inputMint: "So11111111111111111111111111111111111111112"
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

  - name: build_intent_groq
    description: Generate an intent using Groq's LLM API (llama-3.1-8b-instant). Sends a constrained system prompt that forces JSON-only output. Falls back to scripted if parsing fails.
    code_path: src/ai-engines/groq-engine.ts → GroqDecisionEngine.buildIntent()
    requires: GROQ_API_KEY environment variable
    input:
      agentId: "agent-1"
      marketBias: "neutral"
      protocolPreference: "jupiter"
    output: "Same AgentIntent schema as scripted"
    example_command: "GROQ_API_KEY=gsk_... bun run src/main.ts run-swarm --engine=groq"

  - name: build_intent_generic_llm
    description: Generate an intent using any OpenAI-compatible API endpoint (Ollama, Together, Mistral, etc.). Configurable via environment variables.
    code_path: src/ai-engines/generic-llm-engine.ts → GenericLLMEngine.buildIntent()
    requires:
      LLM_ENDPOINT: "https://api.groq.com/openai/v1/chat/completions"
      LLM_MODEL: "llama-3.1-8b-instant"
      LLM_API_KEY: "optional for local providers"
    output: "Same AgentIntent schema"
```

## PolicyGuard Validation Skills (8-Step Pipeline)

```yaml
skills:
  - name: validate_and_execute
    description: Run all 8 policy checks in order, then execute the intent if approved. This is the main entry point — agents call this with an AgentIntent and receive a transaction signature or a PolicyViolationError.
    code_path: src/policy-guard.ts → PolicyGuard.validateAndExecute()
    input:
      agentId: "agent-1"
      type: "swap"
      protocol: "jupiter"
      amountSol: 0.1
      inputMint: "So11111111111111111111111111111111111111112"
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      slippageBps: 50
      rationale: "AI-generated strategy rationale string"
      timestamp: "2026-02-26T22:00:00Z"
    output_success:
      signature: "Base58 transaction signature"
    output_failure:
      error: "PolicyViolationError"
      code: "RATIONALE_REQUIRED | PROTOCOL_BLOCKED | MINT_BLOCKED | MAX_TX_EXCEEDED | MAX_DAILY_EXCEEDED | SLIPPAGE_TOO_HIGH | COOLDOWN_ACTIVE | NETWORK_REJECTED | BLOCKED_ADDRESS | RESERVE_GUARD"
      reason: "Human-readable rejection message"

  - name: policy_check_1_rationale
    description: Reject intents with empty or trivial rationale (less than 10 chars).
    rejection_code: RATIONALE_REQUIRED

  - name: policy_check_2_protocol_allowlist
    description: Only approved protocols pass (default jupiter, raydium).
    rejection_code: PROTOCOL_BLOCKED

  - name: policy_check_3_mint_allowlist
    description: Only allowlisted token mints can be traded (SOL, USDC by default).
    rejection_code: MINT_BLOCKED

  - name: policy_check_4_max_transaction
    description: Per-transaction SOL ceiling (default 0.5 SOL).
    rejection_code: MAX_TX_EXCEEDED

  - name: policy_check_5_daily_spend
    description: Daily cumulative SOL ceiling across all intents (default 5 SOL).
    rejection_code: MAX_DAILY_EXCEEDED

  - name: policy_check_6_slippage
    description: Slippage cap in basis points (default 100 bps).
    rejection_code: SLIPPAGE_TOO_HIGH

  - name: policy_check_7_cooldown
    description: Minimum delay between intents for the same agent (default 10 seconds).
    rejection_code: COOLDOWN_ACTIVE

  - name: policy_check_8_network_reserve
    description: Enforces devnet-only endpoints, blocked address list, and minimum treasury reserve floor (default 0.05 SOL).
    rejection_codes: [NETWORK_REJECTED, BLOCKED_ADDRESS, RESERVE_GUARD]
```

## Execution Skills (On-Chain Operations)

```yaml
skills:
  - name: execute_jupiter_swap
    description: |
      Multi-step Jupiter interaction:
      1. Fetch real-time SOL/USD price from Jupiter Price API v3 (api.jup.ag/price/v3)
      2. Fetch token metadata from Jupiter Tokens API v2 (api.jup.ag/tokens/v2/search)
      3. Fetch a real swap quote from Jupiter Quote API (lite-api.jup.ag/swap/v1/quote) — logs outAmount, priceImpactPct, and route plan hops
      4. Execute a confirmed inter-agent SOL transfer to a peer agent via sendTx from SolanaAgentKit
      Jupiter's swap API returns mainnet ALT transactions that can't land on devnet, so the quote proves dApp connectivity while the SOL transfer proves autonomous signing.
    code_path: src/policy-guard.ts → PolicyGuard.executeJupiterSwap()
    uses: SolanaAgentKit.sendTx()
    jupiter_apis_called:
      - "Price API v3: GET api.jup.ag/price/v3?ids={mints} — real-time USD prices"
      - "Tokens API v2: GET api.jup.ag/tokens/v2/search?query={mint} — token metadata, verification status"
      - "Quote API: GET lite-api.jup.ag/swap/v1/quote — swap routing, outAmount, priceImpact"
    on_chain_actions:
      - sol_transfer: "Inter-agent SOL transfer to peer wallet"
    output:
      signature: "Devnet transaction signature"
      quote_outAmount: "Jupiter quoted output amount"
      priceImpactPct: "Price impact percentage"
      routePlan: "Number of routing hops"
      solPrice: "Real-time SOL/USD price"
      peer: "Recipient peer agent Base58 address"

  - name: execute_raydium_spl_operation
    description: |
      Multi-step Raydium + Token Program interaction:
      1. Verify Raydium Data API reachability (api-v3.raydium.io/main/info)
      2. Fetch real pool data from Raydium Pools API (api-v3.raydium.io/pools/info/list) — logs pool count and top pool by liquidity
      3. Create a new SPL token mint on devnet via @solana/spl-token createMint()
      4. Create associated token account for this agent
      5. Mint tokens to agent's ATA via mintTo()
      6. Create associated token account for a peer agent
      7. Transfer SPL tokens to peer agent via transfer()
      This proves: protocol API interaction, SPL token creation, holding, and transfer.
    code_path: src/policy-guard.ts → PolicyGuard.executeRaydiumDemo()
    uses: "@solana/spl-token (createMint, getOrCreateAssociatedTokenAccount, mintTo, transfer)"
    raydium_apis_called:
      - "Data API: GET api-v3.raydium.io/main/info — protocol health check"
      - "Pools API: GET api-v3.raydium.io/pools/info/list — pool count, top pools by liquidity"
    on_chain_actions:
      - mint_creation: "New SPL token mint on devnet"
      - token_minting: "Mint tokens to agent's ATA"
      - token_transfer: "Transfer SPL tokens to peer agent's ATA"
    output:
      signature: "SPL transfer transaction signature"
      mint: "New SPL token mint address"
      poolCount: "Total Raydium pools (from API)"
      from: "Agent wallet address"
      to: "Peer agent wallet address"

  - name: execute_sol_transfer
    description: Generic inter-agent SOL transfer via SolanaAgentKit sendTx. Round-robin peer selection ensures transfers go to different agents.
    code_path: src/policy-guard.ts → PolicyGuard.executeTransfer()
    uses: SolanaAgentKit.sendTx()
    on_chain_actions:
      - sol_transfer: "SystemProgram.transfer to peer agent"
    output:
      signature: "Devnet transaction signature"
      to: "Peer agent Base58 address"
```

## Audit & Logging Skills

```yaml
skills:
  - name: policy_audit_log
    description: Write approved/rejected action to PolicyVaultClient (Anchor-powered audit logger). Defaults to dry-run mode; set POLICY_VAULT_ONCHAIN=true for on-chain writes.
    code_path: src/policy-vault.ts → PolicyVaultClient.logAction()
    input:
      agentId: "agent-1"
      intentType: "swap"
      protocol: "jupiter"
      approved: true
      reason: "Approved and executed"
      amountSol: 0.1
      signature: "tx signature (if approved)"
    output:
      audit_id: "dryrun-agent-1-1709000000000 (dry-run) | on-chain signature"
```

## Swarm Coordination Skills

```yaml
skills:
  - name: run_coordinated_strategy
    description: Run all agents concurrently. Each agent generates an intent via the AI engine, then processes it through PolicyGuard. Uses Promise.allSettled so one failure doesn't abort the swarm.
    code_path: src/swarm-executor.ts → SwarmExecutor.runCoordinatedYieldStrategy()
    output:
      results:
        - agentId: "agent-1"
          status: "fulfilled"
          signature: "tx signature"
        - agentId: "agent-2"
          status: "rejected"
          error: "PolicyViolationError message"

  - name: subscribe_events
    description: Subscribe to swarm lifecycle events via in-memory event bus.
    code_path: src/swarm-executor.ts → InMemorySwarmBus
    topics:
      - intent.created: "Agent generated an intent"
      - intent.executed: "Intent was approved and executed on-chain"
      - intent.rejected: "Intent was rejected by policy or generation failed"
      - swarm.event: "Catch-all topic for all events"

  - name: attack_simulation
    description: Simulate a malicious intent (oversized amount, weak rationale) to demonstrate PolicyGuard rejection.
    code_path: src/main.ts → attackTest()
    input:
      amountSol: 10
      rationale: "hack"
    output:
      rejected: true
      code: "RATIONALE_REQUIRED"
    example_command: "bun run src/main.ts attack-test"
```

## Policy Configuration

```yaml
skills:
  - name: get_default_policy
    description: Return the default PolicyConfig used by all agents.
    code_path: src/policy-config.ts → getDefaultPolicyConfig()
    defaults:
      maxSolPerTransaction: 0.5
      maxSolDaily: 5
      maxSlippageBps: 100
      allowedProtocols: ["jupiter", "raydium"]
      allowedMints: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
      blockedAddresses: []
      cooldownSeconds: 10
      requireReasonString: true
      enforceDevnetOnly: true
      minTreasuryReserveSol: 0.05

  - name: validate_policy_config
    description: Validate a policy config object against the Zod schema. Used to ensure policy updates conform to safety bounds.
    code_path: src/policy-config.ts → validatePolicyConfig()
    schema_constraints:
      maxSolPerTransaction: "positive, max 0.5"
      maxSolDaily: "positive, max 5"
      maxSlippageBps: "integer, positive, max 250"
      allowedProtocols: "at least 1 protocol"
      allowedMints: "at least 2 mints, each min 32 chars"
```

## How to Use This File

If you are an AI agent reading this file:

1. **To create a wallet**: Use `create_wallet` — call `Keypair.generate()` from `@solana/web3.js`
2. **To generate a trading intent**: Use `build_intent_scripted` or `build_intent_groq` — implement `IAgentDecisionEngine` from `src/types.ts`
3. **To execute an intent**: Pass it to `validate_and_execute` — PolicyGuard handles all signing via SolanaAgentKit
4. **To understand rejections**: Check the `rejection_code` from the 8-step pipeline
5. **Never request private keys** — all signing is handled internally by PolicyGuard
6. **To add a new engine**: Implement `IAgentDecisionEngine.buildIntent()` and inject into `SwarmExecutor`

### Key Interfaces

```typescript
// src/types.ts — The intent schema you produce
interface AgentIntent {
  agentId: string;
  type: "swap" | "add-liquidity" | "remove-liquidity" | "transfer";
  protocol: "jupiter" | "raydium";
  amountSol: number;
  inputMint?: string;
  outputMint?: string;
  slippageBps: number;
  rationale: string;           // Must be ≥10 chars
  metadata?: Record<string, string | number | boolean>;
  timestamp: Date;
}

// src/types.ts — Implement this to plug in your own AI engine
interface IAgentDecisionEngine {
  buildIntent(input: {
    agentId: string;
    marketBias: "bullish" | "bearish" | "neutral";
    protocolPreference: "jupiter" | "raydium";
  }): Promise<AgentIntent>;
}
```
