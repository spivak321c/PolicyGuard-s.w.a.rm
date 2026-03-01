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
    description: Generate a deterministic swap/transfer intent without any API key. Used as default and fallback engine.
    code_path: src/agent-logic.ts → ScriptedDecisionEngine.buildIntent()
    input:
      agentId: "agent-1"
      marketBias: "bullish | bearish | neutral"
      protocolPreference: "raydium | orca | spl-token-swap"
    output:
      type: "swap | transfer"
      protocol: "raydium | orca | spl-token-swap"
      amountSol: 0.4
      slippageBps: 80
      rationale: "Scripted strategy selected raydium for bullish conditions."
      inputMint: "So11111111111111111111111111111111111111112"
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

  - name: build_intent_groq
    description: Generate an intent using Groq's LLM API (llama-3.1-8b-instant). Sends a constrained system prompt that forces JSON-only output. Falls back to scripted if parsing fails.
    code_path: src/ai-engines/groq-engine.ts → GroqDecisionEngine.buildIntent()
    requires: GROQ_API_KEY environment variable
    input:
      agentId: "agent-1"
      marketBias: "neutral"
      protocolPreference: "raydium"
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
      protocol: "raydium"
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
    description: Only approved protocols pass — raydium, orca, spl-token-swap.
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
  - name: execute_raydium_demo
    description: |
      Multi-step Raydium CPMM interaction on devnet:
      1. Load Raydium SDK on devnet
      2. Create mintA + mintB (new SPL token mints)
      3. Create associated token accounts for both mints and mint initial supply
      4. Fetch CPMM fee configs via raydium.api.getCpmmConfigs()
      5. Create a CPMM pool with the two mints
      6. Wait for devnet RPC indexing (1.5s)
      7. Fetch pool info from RPC via getRpcPoolInfos()
      8. Quote the swap using CurveCalculator.swap()
      9. Execute the CPMM swap transaction
      10. Return the confirmed swap transaction ID
      Proves: Raydium SDK integration, SPL token creation, CPMM pool interaction, and on-chain swap execution.
    code_path: src/policy-guard.ts → PolicyGuard.executeRaydiumCpmmSwap()
    uses: "@raydium-io/raydium-sdk-v2 (Raydium.load, cpmm.createPool, cpmm.swap, CurveCalculator)"
    on_chain_actions:
      - mint_creation: "Two new SPL token mints on devnet"
      - pool_creation: "CPMM pool created from the two mints"
      - swap_execution: "CPMM swap confirmed on devnet"
    output:
      signature: "Devnet swap transaction ID"

  - name: execute_sol_transfer
    description: Generic inter-agent SOL transfer via SystemProgram.transfer. Round-robin peer selection ensures transfers go to different agents.
    code_path: src/policy-guard.ts → PolicyGuard.executeTransfer()
    on_chain_actions:
      - sol_transfer: "SystemProgram.transfer to peer agent"
    output:
      signature: "Devnet transaction signature"
      to: "Peer agent Base58 address"

  - name: execute_spl_token_transfer
    description: |
      Fallback execution for spl-token-swap protocol:
      1. Create a new SPL token mint on devnet
      2. Create associated token account for the agent and mint tokens
      3. Create associated token account for a peer agent
      4. Transfer SPL tokens to peer agent
      Returns the confirmed transfer signature.
    code_path: src/policy-guard.ts → PolicyGuard.executeSplTokenTransfer()
    uses: "@solana/spl-token (createMint, getOrCreateAssociatedTokenAccount, mintTo, transfer)"
    on_chain_actions:
      - mint_creation: "New SPL token mint on devnet"
      - token_minting: "Mint tokens to agent's ATA"
      - token_transfer: "Transfer SPL tokens to peer agent's ATA"
    output:
      signature: "SPL transfer transaction signature"
      mint: "New SPL token mint address"
      from: "Agent wallet address"
      to: "Peer agent wallet address"
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
      protocol: "raydium"
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
      allowedProtocols: ["raydium", "orca", "spl-token-swap"]
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
  protocol: "raydium" | "orca" | "spl-token-swap";
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
    protocolPreference: "raydium" | "orca" | "spl-token-swap";
  }): Promise<AgentIntent>;
}
```
