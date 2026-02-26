# SKILLS.md — PolicyGuard Swarm Agentic Wallet

```yaml
skills:
  - name: create_agent_wallet
    description: Create a new isolated Keypair wallet for one swarm agent.
    input_example: {"agent_id":"agent-1"}
    output_example: {"agent_id":"agent-1","wallet":"9x...abc"}
  - name: request_devnet_airdrop
    description: Request SOL from devnet faucet for an agent wallet.
    input_example: {"wallet":"9x...abc","amount_sol":1}
    output_example: {"signature":"5k...sig","status":"confirmed"}
  - name: get_wallet_balance
    description: Return current SOL balance for an isolated wallet.
    input_example: {"wallet":"9x...abc"}
    output_example: {"wallet":"9x...abc","balance_sol":1.24}
  - name: get_spl_balances
    description: Return SPL token balances for a wallet.
    input_example: {"wallet":"9x...abc"}
    output_example: {"tokens":[{"mint":"So111...","amount":0.4}]}
  - name: submit_intent
    description: Submit an intent to PolicyGuard for validation.
    input_example: {"agent_id":"agent-1","type":"swap","amount_sol":0.2}
    output_example: {"intent_id":"intent-100","status":"queued"}
  - name: check_policy
    description: Dry-run all PolicyGuard checks and return decision.
    input_example: {"intent_id":"intent-100"}
    output_example: {"approved":true,"reasons":[]}
  - name: explain_policy_rejection
    description: Human-readable reason for rejection.
    input_example: {"intent_id":"intent-404"}
    output_example: {"approved":false,"reason":"MAX_TX_EXCEEDED"}
  - name: execute_intent
    description: Execute approved intent with automated signing.
    input_example: {"intent_id":"intent-100"}
    output_example: {"signature":"4H...tx"}
  - name: cancel_intent
    description: Cancel queued intent before execution.
    input_example: {"intent_id":"intent-100"}
    output_example: {"status":"cancelled"}
  - name: jupiter_quote
    description: Fetch Jupiter quote for token swap.
    input_example: {"input_mint":"So111...","output_mint":"EPjF...","amount":100000000}
    output_example: {"out_amount":99500000,"route":"best"}
  - name: jupiter_swap
    description: Execute Jupiter swap after policy approval.
    input_example: {"agent_id":"agent-2","amount_sol":0.3}
    output_example: {"signature":"2w...swap"}
  - name: raydium_add_liquidity
    description: Add liquidity to Raydium test pool on devnet.
    input_example: {"pool":"SOL-USDC","amount_sol":0.2}
    output_example: {"signature":"8a...lp"}
  - name: raydium_remove_liquidity
    description: Remove liquidity from Raydium pool.
    input_example: {"pool":"SOL-USDC","lp_amount":10}
    output_example: {"signature":"8b...lpout"}
  - name: policy_audit_log
    description: Write approved/rejected action to PolicyVault on-chain log.
    input_example: {"agent_id":"agent-3","approved":false,"reason":"SLIPPAGE_TOO_HIGH"}
    output_example: {"audit_signature":"3c...audit"}
  - name: policy_config_get
    description: Return current PolicyConfig.
    input_example: {}
    output_example: {"maxSolPerTransaction":0.5,"maxSolDaily":5}
  - name: policy_config_update
    description: Update configurable policy values.
    input_example: {"maxSlippageBps":80}
    output_example: {"status":"updated"}
  - name: agent_status
    description: Check one agent state and role.
    input_example: {"agent_id":"agent-4"}
    output_example: {"status":"idle","role":"risk"}
  - name: swarm_status
    description: View aggregate status of all agents.
    input_example: {}
    output_example: {"agents":6,"executing":2,"paused":0}
  - name: spawn_swarm
    description: Spawn 6-8 isolated agents in one command.
    input_example: {"count":6}
    output_example: {"created":6,"wallets":["A...","B..."]}
  - name: coordinated_strategy_run
    description: Run coordinated yield strategy across swarm.
    input_example: {"strategy":"yield-rotation-v1"}
    output_example: {"status":"completed","events":24}
  - name: event_subscribe
    description: Subscribe to in-memory swarm coordination events.
    input_example: {"topic":"intent.executed"}
    output_example: {"stream":"open"}
  - name: treasury_reserve_check
    description: Ensure reserve floor before execution.
    input_example: {"wallet":"9x...abc"}
    output_example: {"reserve_ok":true,"reserve_sol":0.25}
  - name: cooldown_check
    description: Enforce minimum delay between intents.
    input_example: {"agent_id":"agent-1"}
    output_example: {"allowed":false,"wait_seconds":4}
  - name: slippage_check
    description: Validate requested slippage against config.
    input_example: {"slippage_bps":120}
    output_example: {"approved":false,"max":100}
  - name: protocol_allowlist_check
    description: Confirm protocol is allowlisted.
    input_example: {"protocol":"raydium"}
    output_example: {"approved":true}
  - name: mint_allowlist_check
    description: Confirm mint pair is allowlisted.
    input_example: {"input":"So111...","output":"EPjF..."}
    output_example: {"approved":true}
  - name: blocked_address_check
    description: Reject interactions with blocked targets.
    input_example: {"address":"Bad...Addr"}
    output_example: {"approved":false}
  - name: attack_test
    description: Simulate malicious high-amount intent.
    input_example: {"amount_sol":10}
    output_example: {"approved":false,"reason":"MAX_TX_EXCEEDED"}
  - name: export_audit_report
    description: Export run summary for submission evidence.
    input_example: {"from":"2026-02-01","to":"2026-02-25"}
    output_example: {"approved":44,"rejected":12}
  - name: health_check
    description: Verify RPC + policy vault + agents are reachable.
    input_example: {}
    output_example: {"status":"ok","components":["rpc","vault","swarm"]}
```
