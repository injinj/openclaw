import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { persistInlineAuthFailure } from "./inline-usage.js";
import { logAuthProfileFailureStateChange } from "./state-observation.js";
import { applyScopedAuthReadThrough } from "./store.js";
import type { AuthProfileFailureReason, AuthProfileStore } from "./types.js";
import { resolveBillingLockout } from "./usage-failure-state.js";
import {
  isAuthCooldownBypassedForProvider,
  resolveInlineProviderApiKeyUsageId,
} from "./usage-state.js";

const authProfileUsageLog = createSubsystemLogger("agent/embedded");

export function logDroppedAuthProfileBookkeeping(kind: string, profileId: string): void {
  authProfileUsageLog.warn("dropped auth profile bookkeeping after locked store update failed", {
    event: "auth_profile_bookkeeping_dropped",
    kind,
    profileId,
    tags: ["auth_profiles", "persistence"],
  });
}

export async function markInlineProviderApiKeyFailure(params: {
  store: AuthProfileStore;
  provider: string;
  reason: AuthProfileFailureReason;
  cfg?: OpenClawConfig;
  agentDir: string;
  runId?: string;
  modelId?: string;
}): Promise<void> {
  const { store, provider, reason, cfg, agentDir, runId, modelId } = params;
  if (
    (reason !== "auth" && reason !== "auth_permanent" && reason !== "billing") ||
    isAuthCooldownBypassedForProvider(provider)
  ) {
    return;
  }

  const usageId = resolveInlineProviderApiKeyUsageId(provider);

  const receipt = await persistInlineAuthFailure(agentDir, {
    provider,
    reason,
    modelId,
    billingLockout: resolveBillingLockout(cfg),
  });
  if (receipt) {
    store.usageStats = applyScopedAuthReadThrough(receipt.store).usageStats;
    logAuthProfileFailureStateChange({
      runId,
      profileId: usageId,
      provider,
      reason,
      previous: receipt.previousStats,
      next: receipt.nextStats,
      now: receipt.now,
    });
    return;
  }
  logDroppedAuthProfileBookkeeping("inline_api_key_failure", usageId);
}
