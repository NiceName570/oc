// Purpose: Antigravity tier table: OpenChart tiers to native model identities in preference order.
import {
  TIER1,
  TIER2,
  TIER3,
  TIER4,
  TIER5,
  TIER6,
  type ModelTiers,
} from "@openchart/models/model-tiers";

/**
 * Gemini models share one plan bucket and Claude models another; free plans
 * offer only Gemini, so higher tiers fall back to the top available Gemini 4 model.
 * @example resolveModelTier(ANTIGRAVITY, TIER6, models) prefers Claude Opus, then Sonnet, Gemini 4 Neon, Argon, Hydrogen, Flash.
 */
export const antigravityTiers: ModelTiers = {
  [TIER1]: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"],
  [TIER2]: ["gemini-4-hydrogen", "gemini-3.1-pro"],
  [TIER3]: ["gemini-4-argon"],
  [TIER4]: ["gemini-4-neon"],
  [TIER5]: ["claude-sonnet-5-5"],
  [TIER6]: ["claude-opus-5-5"],
};
