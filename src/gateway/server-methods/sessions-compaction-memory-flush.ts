// Pre-compaction memory flush for the sessions.compact RPC path.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadAgentRunnerMemoryRuntime } from "../../agents/command/runtime-loaders.js";
import { createSessionMaintenanceFollowup } from "../../agents/session-maintenance/run.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { normalizeThinkLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSessionModelRef } from "../session-utils.js";

const log = createSubsystemLogger("gateway/sessions-compact");

export type GatewaySessionCompactionMemoryFlushParams = {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  /** Canonical session key the flush accounts against. */
  sessionKey: string;
  storePath: string;
  abortSignal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
};

export type GatewaySessionCompactionMemoryFlushOutcome =
  | "completed"
  | "skipped"
  | "failed"
  | "exhausted"
  | "threw";

/**
 * Give the agent the same chance to persist memory before an operator-requested
 * compaction as automatic compaction does. No chat context exists on the RPC path,
 * so the follow-up is rebuilt from the session row the way the automatic
 * maintenance path does. The flush helper owns the gate (threshold, per-compaction
 * dedupe, memoryFlush.enabled, sandbox, CLI runtimes). A failed, exhausted, or
 * throwing flush is logged and never blocks the compaction; callers re-check the
 * abort signal afterwards so a cancelled request still stops before compacting.
 */
export async function runGatewaySessionCompactionMemoryFlush(
  params: GatewaySessionCompactionMemoryFlushParams,
): Promise<GatewaySessionCompactionMemoryFlushOutcome> {
  const { cfg, entry, agentId, sessionKey } = params;
  try {
    const resolvedModel = resolveSessionModelRef(cfg, entry, agentId);
    const workspaceDir =
      resolveIngressWorkspaceOverrideForSessionRun({
        spawnedBy: entry.spawnedBy,
        workspaceDir: entry.spawnedWorkspaceDir,
        cwd: entry.spawnedCwd,
      }) ?? resolveAgentWorkspaceDir(cfg, agentId);
    const followupRun = createSessionMaintenanceFollowup({
      run: {
        agentId,
        agentDir: resolveAgentDir(cfg, agentId),
        workspaceDir,
        cwd: normalizeOptionalString(entry.spawnedCwd) ?? workspaceDir,
        // Operator RPCs carry no channel; the flush runs as system-owned work.
        messageProvider: undefined,
        // Current delivery owns the account; group session keys carry none themselves.
        agentAccountId:
          entry.delivery?.kind === "external" ? entry.delivery.context?.accountId : undefined,
        chatType: entry.chatType,
        groupId: entry.groupId,
        groupChannel: entry.groupChannel,
        groupSpace: entry.space,
        skillsSnapshot: entry.skillsSnapshot,
        thinkLevel: normalizeThinkLevel(entry.thinkingLevel),
        verboseLevel: "off",
        timeoutMs: resolveAgentTimeoutMs({ cfg }),
        // No trusted chat sender exists on the RPC path; the flush audience stays non-owner.
        senderIsOwner: false,
      },
      sessionEntry: entry,
      cfg,
      sessionKey,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      auth: {
        authProfileId: entry.authProfileOverride?.trim() || undefined,
        authProfileIdSource: resolveCollapsedSessionAuthPinSource(entry),
      },
    });
    followupRun.operatorAuthority = params.operatorAuthority;
    const memory = await loadAgentRunnerMemoryRuntime();
    const flushed = await memory.runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: "",
      defaultModel: resolvedModel.model,
      resolvedVerboseLevel: "off",
      sessionEntry: entry,
      sessionStore: { [sessionKey]: entry },
      sessionKey,
      runtimePolicySessionKey: sessionKey,
      storePath: params.storePath,
      isHeartbeat: false,
      abortSignal: params.abortSignal,
    });
    if (flushed.outcome === "failed" || flushed.outcome === "exhausted") {
      log.warn(
        `sessions.compact memory flush ${flushed.outcome} for ${sessionKey}; compacting anyway`,
      );
    }
    return flushed.outcome;
  } catch (error) {
    log.warn(
      `sessions.compact memory flush threw for ${sessionKey}; compacting anyway: ${formatErrorMessage(error)}`,
    );
    return "threw";
  }
}
