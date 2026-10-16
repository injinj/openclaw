import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import {
  classifyCompactionReason,
  isBenignCompactionSkipResult,
} from "../../agents/embedded-agent-runner/compact-reasons.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  resolveContextConfigProviderForRuntime,
} from "../../agents/openai-routing.js";
import { resolveOwnerPromptNumbers } from "../../agents/owner-display.js";
import { resolveManualCompactionCliTarget } from "../../agents/session-runtime-compat.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { matchCommandPrefix, rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";
import { createCompactionNoticePayload } from "./compaction-notice.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

const compactCommandLog = createSubsystemLogger("auto-reply/compaction");

/** Bare-word and flag spellings that skip the pre-compaction memory flush. */
const COMPACT_NO_FLUSH_TOKENS = new Set(["--no-flush", "--noflush", "noflush"]);

export type CompactCommandArgs = {
  customInstructions?: string;
  skipMemoryFlush: boolean;
};

/** Split /compact arguments into flags and the free-text summary instructions. */
export function parseCompactCommandArgs(rest: string | undefined): CompactCommandArgs {
  const text = rest?.trim() ?? "";
  if (!text) {
    return { skipMemoryFlush: false };
  }
  let skipMemoryFlush = false;
  const remaining: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (COMPACT_NO_FLUSH_TOKENS.has(normalizeLowercaseStringOrEmpty(token))) {
      skipMemoryFlush = true;
      continue;
    }
    remaining.push(token);
  }
  const customInstructions = remaining.join(" ").trim();
  return {
    customInstructions: customInstructions.length ? customInstructions : undefined,
    skipMemoryFlush,
  };
}

function extractCompactArgs(params: {
  rawBody?: string;
  ctx: import("../templating.js").MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): CompactCommandArgs {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg, params.agentId)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed.toLowerCase().startsWith("/compact")) {
    return { skipMemoryFlush: false };
  }
  let rest = trimmed.slice("/compact".length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  return parseCompactCommandArgs(rest);
}

function formatCompactionReason(reason?: string): string | undefined {
  const text = normalizeOptionalString(reason);
  if (!text) {
    return undefined;
  }
  const classification = classifyCompactionReason(reason);
  if (classification === "no_compactable_entries") {
    return "nothing compactable in this session yet";
  }
  if (classification === "already_compacted") {
    return "session is already compacted";
  }
  return classification === "below_threshold"
    ? normalizeLowercaseStringOrEmpty(reason).includes("already under target")
      ? "context is already under the compaction target"
      : "context is below the compaction threshold"
    : text;
}

function compactionUnavailable(reason: string, interruptionNotice = ""): CommandHandlerResult {
  return {
    shouldContinue: false,
    sessionCompaction: { compacted: false, reason },
    reply: {
      text: `⚙️ Compaction unavailable: ${reason}.${interruptionNotice}`,
      isStatusNotice: true,
    },
  };
}

function resolveManualCompactContextTokenBudget(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  agentId: string;
  sessionKey: string;
  liveContextTokens?: number;
  persistedContextTokens?: number;
}): number | undefined {
  const liveContextTokens = normalizeContextTokenBudget(params.liveContextTokens);

  const model = normalizeOptionalString(params.model);
  const provider = normalizeOptionalString(params.provider);
  if (!model || !provider) {
    return liveContextTokens ?? normalizeContextTokenBudget(params.persistedContextTokens);
  }

  const harnessPolicy = resolveAgentHarnessPolicy({
    provider,
    modelId: model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const contextConfigProvider = resolveContextConfigProviderForRuntime({
    provider,
    runtimeId: harnessPolicy.runtime,
    config: params.cfg,
  });
  const configuredContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: contextConfigProvider,
    model: resolveManualCompactContextModelId({
      provider,
      contextConfigProvider,
      model,
    }),
    allowAsyncLoad: false,
  });
  if (configuredContextTokens !== undefined && configuredContextTokens > 0) {
    const configuredBudget = Math.floor(configuredContextTokens);
    return liveContextTokens !== undefined
      ? Math.min(liveContextTokens, configuredBudget)
      : configuredBudget;
  }

  return liveContextTokens ?? normalizeContextTokenBudget(params.persistedContextTokens);
}

function normalizeContextTokenBudget(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function resolveManualCompactContextModelId(params: {
  provider: string;
  contextConfigProvider: string;
  model: string;
}): string {
  const model = params.model;
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) {
    return model;
  }

  const modelProvider = normalizeProviderId(model.slice(0, slashIndex));
  const selectedProvider = normalizeProviderId(params.provider);
  const contextConfigProvider = normalizeProviderId(params.contextConfigProvider);
  const modelId = model.slice(slashIndex + 1).trim();
  if (!modelId) {
    return model;
  }

  if (
    modelProvider === selectedProvider ||
    modelProvider === contextConfigProvider ||
    (modelProvider === OPENAI_PROVIDER_ID && contextConfigProvider === OPENAI_CODEX_PROVIDER_ID)
  ) {
    return modelId;
  }

  return model;
}

export async function handleCompactCommand(
  params: Parameters<CommandHandler>[0],
  _allowTextCommands: boolean,
  assertOwnerCurrent?: () => void,
): ReturnType<CommandHandler> {
  if (matchCommandPrefix(params.command.commandBodyNormalized, "/compact") === null) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/compact");
  if (unauthorized) {
    return unauthorized;
  }
  const operatorAuthority = params.opts?.operatorAuthority;
  operatorAuthority?.assertCurrent();
  const targetSessionEntry = params.commandInvocationSignal
    ? params.compactionSessionEntry
    : (params.sessionStore?.[params.sessionKey] ?? params.sessionEntry);
  if (!targetSessionEntry?.sessionId) {
    return compactionUnavailable("missing session id");
  }
  const runtime = await import("./commands-compact.runtime.js");
  const sessionId = targetSessionEntry.sessionId;
  const sessionAgentId = params.sessionKey
    ? resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: params.cfg,
        agentId: params.agentId,
      })
    : (params.agentId ?? "main");
  const currentAgentId = params.agentId ?? "main";
  const sessionAgentDir =
    sessionAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, sessionAgentId);
  const { customInstructions, skipMemoryFlush } = extractCompactArgs({
    rawBody: params.ctx.commandText,
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: sessionAgentId,
    isGroup: params.isGroup,
  });
  const contextTokenBudget = resolveManualCompactContextTokenBudget({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    liveContextTokens: params.contextTokens,
    persistedContextTokens: targetSessionEntry.contextTokens,
  });
  const compactionStorePath = resolveSessionStorePathForScope({
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    storePath:
      params.storePath ??
      resolveSessionStorePathCore(params.cfg.session?.store, { agentId: sessionAgentId }),
  });
  let expectedSession: InternalSessionEntry = targetSessionEntry;
  let compactionAccepted = false;
  let ingressAdopted = false;
  const assertOwnerBeforeAcceptance = () => {
    operatorAuthority?.assertCurrent();
    if (!compactionAccepted) {
      params.command.assertOwnerCurrent?.();
      assertOwnerCurrent?.();
    }
  };
  let currentRead: Awaited<ReturnType<typeof runtime.prepareCurrentSessionEntry>>;
  using _ = { [Symbol.dispose]: () => currentRead?.release() };
  const prepareCurrentEntry = async () => {
    const prepared = await runtime.prepareCurrentSessionEntry({
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      storePath: compactionStorePath,
      expected: expectedSession,
    });
    currentRead?.release();
    currentRead = prepared;
    return prepared;
  };
  let interruptionNotice = "";
  const authorityFailure = () => {
    const reason =
      params.commandInvocationSignal?.aborted || params.opts?.abortSignal?.aborted
        ? "command invocation closed"
        : undefined;
    return reason ? compactionUnavailable(reason, interruptionNotice) : undefined;
  };
  let failure = authorityFailure();
  if (failure) {
    return failure;
  }
  assertOwnerBeforeAcceptance();
  if (runtime.isEmbeddedAgentRunAbortableForCompaction(sessionId)) {
    // Preserve the pending answer when the active turn can finish on its own.
    const settled = await runtime.waitForEmbeddedAgentRunEnd(sessionId, 60_000);
    failure = authorityFailure();
    if (failure) {
      return failure;
    }
    assertOwnerBeforeAcceptance();
    if (!settled) {
      if (!(await prepareCurrentEntry())) {
        return compactionUnavailable("command session changed", interruptionNotice);
      }
      params.opts?.turnAdoptionLifecycle?.abortSignal?.throwIfAborted();
      await params.opts?.turnAdoptionLifecycle?.onAdopted();
      ingressAdopted = true;
      failure = authorityFailure();
      if (failure) {
        return failure;
      }
      assertOwnerBeforeAcceptance();
      currentRead?.assertCurrent();
      interruptionNotice = runtime.abortEmbeddedAgentRun(sessionId)
        ? "\n⚠️ Your in-flight request was aborted by compaction — please resend it."
        : "";
      currentRead?.release();
      currentRead = undefined;
      const drained = await runtime.waitForEmbeddedAgentRunEnd(sessionId, 15_000);
      failure = authorityFailure();
      if (failure) {
        return failure;
      }
      assertOwnerBeforeAcceptance();
      if (!drained) {
        return compactionUnavailable("the previous run is still stopping", interruptionNotice);
      }
    }
  }
  const thinkLevel = params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel());
  failure = authorityFailure();
  if (failure) {
    return failure;
  }
  assertOwnerBeforeAcceptance();
  if (!skipMemoryFlush) {
    // Manual compaction summarizes the same context automatic compaction would, so
    // give the agent the same chance to persist memory first. The flush helper owns
    // the gate (threshold, per-compaction dedupe, memoryFlush.enabled, sandbox, CLI
    // runtimes); a failed or timed-out flush never blocks the user's compact.
    const preFlush = await prepareCurrentEntry();
    if (!preFlush) {
      return compactionUnavailable("command session changed", interruptionNotice);
    }
    const preFlushEntry = preFlush.entry;
    // The flush writes the row (flush accounting, writer custody); drop this read's
    // guard so its own writes do not read as a session change. Dispatch re-reads.
    currentRead?.release();
    currentRead = undefined;
    try {
      const followupRun = runtime.createSessionMaintenanceFollowup({
        run: {
          agentId: sessionAgentId,
          agentDir: sessionAgentDir,
          workspaceDir: params.workspaceDir,
          cwd: params.workspaceDir,
          messageProvider: params.command.channel,
          agentAccountId: params.ctx.AccountId,
          chatType: normalizeChatType(params.ctx.ChatType),
          conversationRoutePeerId: params.ctx.ConversationRoutePeerId,
          conversationToolPolicy: params.ctx.ConversationToolPolicy,
          groupId: preFlushEntry.groupId,
          groupChannel: preFlushEntry.groupChannel,
          groupSpace: preFlushEntry.space,
          skillsSnapshot: preFlushEntry.skillsSnapshot,
          thinkingCatalog: params.thinkingCatalog,
          thinkLevel,
          verboseLevel: params.resolvedVerboseLevel ?? "off",
          timeoutMs: resolveAgentTimeoutMs({ cfg: params.cfg }),
          senderIsOwner: params.command.senderIsOwner,
        },
        sessionEntry: preFlushEntry,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        provider: params.provider,
        model: params.model,
        auth: {
          authProfileId: preFlushEntry.authProfileOverride?.trim() || undefined,
          authProfileIdSource: resolveCollapsedSessionAuthPinSource(preFlushEntry),
        },
      });
      followupRun.operatorAuthority = operatorAuthority;
      const flushed = await runtime.runMemoryFlushIfNeeded({
        cfg: params.cfg,
        followupRun,
        promptForEstimate: "",
        defaultModel: params.model,
        resolvedVerboseLevel: params.resolvedVerboseLevel ?? "off",
        sessionEntry: preFlushEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        runtimePolicySessionKey: params.sessionKey,
        storePath: compactionStorePath,
        isHeartbeat: false,
        replyOperation: params.opts?.replyOperation,
        abortSignal: params.opts?.abortSignal,
      });
      if (flushed.outcome === "failed" || flushed.outcome === "exhausted") {
        compactCommandLog.warn(
          `manual /compact memory flush ${flushed.outcome} for ${params.sessionKey}; compacting anyway`,
        );
      }
    } catch (error) {
      compactCommandLog.warn(
        `manual /compact memory flush threw for ${params.sessionKey}; compacting anyway: ${formatErrorMessage(error)}`,
      );
    }
    failure = authorityFailure();
    if (failure) {
      return failure;
    }
    assertOwnerBeforeAcceptance();
  }
  // Prepare one current row at compaction dispatch; write receipts keep its guard live.
  const prepared = await prepareCurrentEntry();
  if (!prepared) {
    return compactionUnavailable("command session changed", interruptionNotice);
  }
  expectedSession = prepared.entry;
  if (params.sessionStore) {
    params.sessionStore[params.sessionKey] = prepared.entry;
  }
  const compactionCliTarget = resolveManualCompactionCliTarget({
    provider: params.provider,
    entry: prepared.entry,
    cfg: params.cfg,
  });
  const assertActive = () => {
    assertOwnerBeforeAcceptance();
    params.opts?.abortSignal?.throwIfAborted();
    params.commandInvocationSignal?.throwIfAborted();
    currentRead?.assertCurrent();
  };
  // Keep read-only preflight retryable; adopt before the first compaction effect.
  if (!ingressAdopted) {
    params.opts?.turnAdoptionLifecycle?.abortSignal?.throwIfAborted();
    await params.opts?.turnAdoptionLifecycle?.onAdopted();
  }
  failure = authorityFailure();
  if (failure) {
    return failure;
  }
  assertActive();
  const replyOperation = params.opts?.replyOperation;
  replyOperation?.setPhase("preflight_compacting");
  const compaction = runtime.compactEmbeddedAgentSession(
    {
      abortSignal: params.opts?.abortSignal,
      contextEngineAgentId: sessionAgentId,
      sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: {
        agentId: sessionAgentId,
        sessionId,
        sessionKey: params.sessionKey,
        storePath: compactionStorePath,
      },
      allowGatewaySubagentBinding: true,
      messageChannel: params.command.channel,
      clientCaps: params.ctx.GatewayClientCaps,
      conversationToolPolicy: params.ctx.ConversationToolPolicy,
      groupId: expectedSession.groupId,
      groupChannel: expectedSession.groupChannel,
      groupSpace: expectedSession.space,
      spawnedBy: expectedSession.spawnedBy,
      senderId: params.command.senderId,
      senderName: params.ctx.SenderName,
      senderUsername: params.ctx.SenderUsername,
      senderE164: params.ctx.SenderE164,
      inputProvenance: params.ctx.InputProvenance,
      sessionFile: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: sessionAgentDir,
      config: params.cfg,
      // Group session keys carry no account identity, so without this manual
      // /compact resolves the root history limit while prompt preparation used the
      // account limit.
      agentAccountId: params.ctx.AccountId,
      conversationRoutePeerId: params.ctx.ConversationRoutePeerId,
      chatType: normalizeChatType(params.ctx.ChatType),
      skillsSnapshot: expectedSession.skillsSnapshot,
      provider: params.provider,
      model: params.model,
      authProfileId:
        compactionCliTarget.cliSessionBinding?.authProfileId ?? expectedSession.authProfileOverride,
      authProfileIdSource: resolveCollapsedSessionAuthPinSource(expectedSession),
      contextTokenBudget,
      agentHarnessId: compactionCliTarget.agentHarnessId,
      cliSessionId: compactionCliTarget.cliSessionId,
      cliSessionBinding: compactionCliTarget.cliSessionBinding,
      sessionEntry: expectedSession,
      modelSelectionLocked: expectedSession.modelSelectionLocked === true,
      thinkLevel,
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      customInstructions,
      trigger: "manual",
      ownerNumbers: resolveOwnerPromptNumbers({
        ownerNumbers: params.command.ownerList,
        senderId: params.command.senderId,
        senderIsOwner: params.command.senderIsOwner,
      }),
    },
    {
      assertActive,
      sourceAuthority: { assertActive, operatorAuthority },
      onCommitted: (accepted) => {
        compactionAccepted = true;
        currentRead?.release();
        currentRead = undefined;
        // Update the expectation before identity observers run, not from public result metadata.
        expectedSession = accepted.entry;
        if (params.sessionStore) {
          params.sessionStore[params.sessionKey] = accepted.entry;
        }
      },
      onHostCompactionCommitted: () => {
        compactionAccepted = true;
        currentRead?.release();
        currentRead = undefined;
      },
    },
  );
  const result = await compaction.finally(() => replyOperation?.setPhase("running"));
  currentRead?.release();
  currentRead = undefined;

  const tokensAfterCompaction = result.result?.tokensAfter;
  const didCompact = result.ok && result.compacted;
  let compactLabel =
    result.ok || isBenignCompactionSkipResult(result) ? "Compaction skipped" : "Compaction failed";
  if (didCompact) {
    compactLabel =
      tokensAfterCompaction === undefined
        ? "Compaction finished (resulting context unknown)"
        : result.result?.tokensBefore != null
          ? `${result.compactionKind === "server-endpoint" ? "Server-side compaction" : "Compacted"} (${runtime.formatTokenCount(result.result.tokensBefore)} → ${runtime.formatTokenCount(tokensAfterCompaction)})`
          : "Compacted";
    const compactionCount = await runtime.incrementCompactionCount({
      agentId: sessionAgentId,
      sessionEntry: expectedSession,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: compactionStorePath,
      tokensAfter: result.result?.tokensAfter,
      compactionKind: result.compactionKind,
      expectedSession,
      transcriptByteCompactionLatch: result.compactionKind === "native-harness" ? undefined : null,
    });
    if (compactionCount === undefined) {
      return compactionUnavailable("session accounting failed", interruptionNotice);
    }
  }
  failure = authorityFailure();
  if (failure) {
    return failure;
  }
  const totalTokens = didCompact
    ? tokensAfterCompaction
    : runtime.resolveFreshSessionTotalTokens(targetSessionEntry);
  const contextSummary = runtime.formatContextUsageShort(
    totalTokens !== undefined && totalTokens > 0 ? totalTokens : null,
    contextTokenBudget ?? null,
  );
  const reason = formatCompactionReason(result.reason);
  const line = `${compactLabel}${reason ? `: ${reason}` : ""} • ${contextSummary}`;
  const degradedNotice =
    didCompact && parseCompactionDetails(result.result?.details)?.qualityDegraded
      ? `\n${createCompactionNoticePayload({ phase: "degraded" }).text}`
      : "";
  runtime.enqueueSystemEvent(line, {
    sessionKey: resolveSystemEventQueueKey(params.sessionKey, sessionAgentId),
  });
  return {
    shouldContinue: false,
    sessionCompaction: {
      compacted: didCompact,
      reason: result.reason,
      tokensBefore: result.result?.tokensBefore,
      tokensAfter: tokensAfterCompaction,
    },
    reply: {
      text: `⚙️ ${line}${degradedNotice}${interruptionNotice}`,
      isStatusNotice: true,
    },
  };
}
