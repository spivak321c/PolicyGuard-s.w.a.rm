import { z } from "zod";
import type { PolicyConfig } from "./types";

export const PolicyConfigSchema = z.object({
  maxSolPerTransaction: z.number().positive().max(0.5),
  maxSolDaily: z.number().positive().max(5),
  maxSlippageBps: z.number().int().positive().max(250),
  allowedProtocols: z.array(z.enum(["jupiter", "raydium"])).min(1),
  allowedMints: z.array(z.string().min(32)).min(2),
  blockedAddresses: z.array(z.string().min(32)).default([]),
  cooldownSeconds: z.number().int().nonnegative(),
  requireReasonString: z.boolean(),
  enforceDevnetOnly: z.boolean(),
  minTreasuryReserveSol: z.number().nonnegative()
});

export const DEVNET_SOL = "So11111111111111111111111111111111111111112";
export const DEVNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function getDefaultPolicyConfig(): PolicyConfig {
  return {
    maxSolPerTransaction: 0.5,
    maxSolDaily: 5,
    maxSlippageBps: 100,
    allowedProtocols: ["jupiter", "raydium"],
    allowedMints: [DEVNET_SOL, DEVNET_USDC],
    blockedAddresses: [],
    cooldownSeconds: 10,
    requireReasonString: true,
    enforceDevnetOnly: true,
    minTreasuryReserveSol: 0.05
  };
}

export function validatePolicyConfig(config: PolicyConfig): PolicyConfig {
  return PolicyConfigSchema.parse(config);
}
