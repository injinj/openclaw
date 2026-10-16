// Tests that manual /compact runs the pre-compaction memory flush with automatic-path gating.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlan,
} from "../../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { runMemoryFlushIfNeeded as runMemoryFlushIfNeededActual } from "./agent-runner-memory.js";
import { parseCompactCommandArgs } from "./commands-compact.js";
import {
  buildCompactParams,
  compactEmbeddedAgentSession,
  createSessionMaintenanceFollowup,
  handleCompactCommand,
  incrementCompactionCount,
  prepareCurrentSessionEntry,
  requireCompactEmbeddedAgentSessionCall,
  requireRunMemoryFlushIfNeededCall,
  resetCompactCommandMocks,
  runMemoryFlushIfNeeded,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const compactCommandConfig: OpenClawConfig = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
};

type CallOrder = Array<"flush" | "compact">;

function buildFlushCompactParams(
  commandBody: string,
  sessionEntry: SessionEntry,
  overrides: Partial<HandleCommandsParams> = {},
): HandleCommandsParams {
  const base = buildCompactParams(commandBody, compactCommandConfig);
  return {
    ...base,
    ctx: {
      ...base.ctx,
      CommandBody: commandBody,
      commandText: commandBody,
      AccountId: "acct-1",
      ChatType: "direct",
    },
    provider: "anthropic",
    model: "claude-opus-4",
    workspaceDir: "/tmp/openclaw-compact-workspace",
    agentDir: "/tmp/openclaw-compact-agent",
    resolvedThinkLevel: "low",
    resolvedVerboseLevel: "off",
    thinkingCatalog: [{ provider: "anthropic", id: "claude-opus-4", input: ["text"] }],
    sessionEntry,
    sessionStore: { [base.sessionKey]: sessionEntry },
    ...overrides,
  } as HandleCommandsParams;
}

/** Serve the full fixture row from the current-entry reads instead of the id-only stub. */
function serveCurrentEntry(sessionEntry: SessionEntry) {
  vi.mocked(prepareCurrentSessionEntry).mockImplementation(async ({ expected }) => ({
    entry: { ...sessionEntry, ...expected },
    assertCurrent() {},
    release() {},
  }));
}

function recordCallOrder(order: CallOrder) {
  vi.mocked(runMemoryFlushIfNeeded).mockImplementation(async (params) => {
    order.push("flush");
    return { sessionEntry: params.sessionEntry, outcome: "completed" };
  });
  vi.mocked(compactEmbeddedAgentSession).mockImplementation(async () => {
    order.push("compact");
    return { ok: true, compacted: true, result: { tokensBefore: 90_000, tokensAfter: 9_000 } };
  });
}

describe("parseCompactCommandArgs", () => {
  it("keeps plain instructions and defaults to flushing", () => {
    expect(parseCompactCommandArgs("Focus on the API design decisions")).toEqual({
      customInstructions: "Focus on the API design decisions",
      skipMemoryFlush: false,
    });
    expect(parseCompactCommandArgs(undefined)).toEqual({ skipMemoryFlush: false });
    expect(parseCompactCommandArgs("   ")).toEqual({ skipMemoryFlush: false });
  });

  it.each(["--no-flush", "--noflush", "noflush", "NoFlush", "--NO-FLUSH"])(
    "treats %s as the flush opt-out",
    (token) => {
      expect(parseCompactCommandArgs(token)).toEqual({ skipMemoryFlush: true });
    },
  );

  it("strips the opt-out token from instructions wherever it appears", () => {
    expect(parseCompactCommandArgs("--no-flush focus on decisions")).toEqual({
      customInstructions: "focus on decisions",
      skipMemoryFlush: true,
    });
    expect(parseCompactCommandArgs("focus on decisions noflush")).toEqual({
      customInstructions: "focus on decisions",
      skipMemoryFlush: true,
    });
    expect(parseCompactCommandArgs("focus --no-flush on decisions")).toEqual({
      customInstructions: "focus on decisions",
      skipMemoryFlush: true,
    });
  });

  it("does not treat the opt-out as a substring match", () => {
    expect(parseCompactCommandArgs("explain the noflush-mode bug")).toEqual({
      customInstructions: "explain the noflush-mode bug",
      skipMemoryFlush: false,
    });
  });
});

describe("handleCompactCommand memory flush", () => {
  beforeEach(resetCompactCommandMocks);

  it("runs the memory flush before compaction with the pre-compaction session entry", async () => {
    const order: CallOrder = [];
    recordCallOrder(order);
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      totalTokens: 150_000,
      totalTokensFresh: true,
      compactionCount: 24,
      memoryFlush: { kind: "succeeded", compactionCount: 23 },
      groupId: "group-1",
      groupChannel: "#general",
      space: "workspace-1",
      skillsSnapshot: { prompt: "", skills: [] },
      authProfileOverride: "anthropic:work",
    };
    serveCurrentEntry(sessionEntry);
    const abortController = new AbortController();

    const result = await handleCompactCommand(
      buildFlushCompactParams("/compact focus on decisions", sessionEntry, {
        opts: { abortSignal: abortController.signal },
        storePath: "/tmp/openclaw-compact-store/sessions.json",
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.sessionCompaction?.compacted).toBe(true);
    expect(order).toEqual(["flush", "compact"]);
    expect(vi.mocked(runMemoryFlushIfNeeded)).toHaveBeenCalledOnce();

    const flushCall = requireRunMemoryFlushIfNeededCall();
    expect(flushCall.sessionEntry).toMatchObject({
      sessionId: "session-1",
      compactionCount: 24,
      memoryFlush: { compactionCount: 23 },
    });
    expect(flushCall.sessionKey).toBe("agent:main:main");
    expect(flushCall.runtimePolicySessionKey).toBe("agent:main:main");
    expect(flushCall.storePath).toContain("openclaw-compact-store");
    expect(flushCall.isHeartbeat).toBe(false);
    expect(flushCall.promptForEstimate).toBe("");
    expect(flushCall.defaultModel).toBe("claude-opus-4");
    expect(flushCall.abortSignal).toBe(abortController.signal);

    expect(vi.mocked(createSessionMaintenanceFollowup)).toHaveBeenCalledOnce();
    const followupParams = vi.mocked(createSessionMaintenanceFollowup).mock.calls[0]?.[0];
    expect(followupParams?.run).toMatchObject({
      agentId: "main",
      agentDir: "/tmp/openclaw-compact-agent",
      workspaceDir: "/tmp/openclaw-compact-workspace",
      messageProvider: "whatsapp",
      agentAccountId: "acct-1",
      groupId: "group-1",
      groupChannel: "#general",
      groupSpace: "workspace-1",
      thinkLevel: "low",
      verboseLevel: "off",
      senderIsOwner: false,
    });
    expect(followupParams?.provider).toBe("anthropic");
    expect(followupParams?.model).toBe("claude-opus-4");
    expect(followupParams?.auth.authProfileId).toBe("anthropic:work");
    expect(flushCall.followupRun.run.sessionId).toBe("session-1");

    // The pre-flush read is released before the flush; dispatch re-reads the row.
    expect(vi.mocked(prepareCurrentSessionEntry)).toHaveBeenCalledTimes(2);
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.trigger).toBe("manual");
    expect(compactCall.customInstructions).toBe("focus on decisions");
    expect(vi.mocked(incrementCompactionCount)).toHaveBeenCalledOnce();
  });

  it("dispatches compaction against the row re-read after the flush", async () => {
    const order: CallOrder = [];
    recordCallOrder(order);
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      totalTokens: 150_000,
      totalTokensFresh: true,
      compactionCount: 24,
      memoryFlush: { kind: "succeeded", compactionCount: 23 },
    };
    let reads = 0;
    vi.mocked(prepareCurrentSessionEntry).mockImplementation(async ({ expected }) => {
      reads += 1;
      const entry =
        reads === 1
          ? { ...sessionEntry, ...expected }
          : {
              ...sessionEntry,
              ...expected,
              memoryFlush: { kind: "succeeded" as const, compactionCount: 24 },
              skillsSnapshot: { prompt: "after-flush", skills: [] },
            };
      return { entry, assertCurrent() {}, release() {} };
    });

    const result = await handleCompactCommand(
      buildFlushCompactParams("/compact", sessionEntry),
      true,
    );

    expect(result?.sessionCompaction?.compacted).toBe(true);
    expect(order).toEqual(["flush", "compact"]);
    expect(requireRunMemoryFlushIfNeededCall().sessionEntry).toMatchObject({
      memoryFlush: { compactionCount: 23 },
    });
    expect(requireCompactEmbeddedAgentSessionCall().sessionEntry).toMatchObject({
      memoryFlush: { compactionCount: 24 },
      skillsSnapshot: { prompt: "after-flush" },
    });
  });

  it.each(["/compact --no-flush", "/compact noflush", "/compact --no-flush focus on decisions"])(
    "skips the memory flush for %s",
    async (commandBody) => {
      const order: CallOrder = [];
      recordCallOrder(order);
      const sessionEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: Date.now(),
        totalTokens: 150_000,
        totalTokensFresh: true,
        compactionCount: 24,
      };

      const result = await handleCompactCommand(
        buildFlushCompactParams(commandBody, sessionEntry),
        true,
      );

      expect(result?.sessionCompaction?.compacted).toBe(true);
      expect(order).toEqual(["compact"]);
      expect(vi.mocked(runMemoryFlushIfNeeded)).not.toHaveBeenCalled();
      expect(vi.mocked(createSessionMaintenanceFollowup)).not.toHaveBeenCalled();
      expect(vi.mocked(prepareCurrentSessionEntry)).toHaveBeenCalledOnce();
      const compactCall = requireCompactEmbeddedAgentSessionCall();
      expect(compactCall.customInstructions).toBe(
        commandBody.includes("focus") ? "focus on decisions" : undefined,
      );
    },
  );

  it("still compacts when the memory flush throws", async () => {
    vi.mocked(runMemoryFlushIfNeeded).mockRejectedValueOnce(new Error("flush model exploded"));
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { tokensBefore: 90_000, tokensAfter: 9_000 },
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      totalTokens: 150_000,
      totalTokensFresh: true,
      compactionCount: 24,
    };

    const result = await handleCompactCommand(
      buildFlushCompactParams("/compact", sessionEntry),
      true,
    );

    expect(vi.mocked(runMemoryFlushIfNeeded)).toHaveBeenCalledOnce();
    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledOnce();
    expect(result?.sessionCompaction?.compacted).toBe(true);
    expect(result?.reply?.text).toContain("Compacted");
  });

  it("still compacts when the memory flush reports failure", async () => {
    vi.mocked(runMemoryFlushIfNeeded).mockImplementationOnce(async (params) => ({
      sessionEntry: params.sessionEntry,
      outcome: "failed",
    }));
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { tokensBefore: 90_000, tokensAfter: 9_000 },
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      totalTokens: 150_000,
      totalTokensFresh: true,
      compactionCount: 24,
    };

    const result = await handleCompactCommand(
      buildFlushCompactParams("/compact", sessionEntry),
      true,
    );

    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledOnce();
    expect(result?.sessionCompaction?.compacted).toBe(true);
  });

  it("does not compact when the user aborts during the memory flush", async () => {
    const abortController = new AbortController();
    vi.mocked(runMemoryFlushIfNeeded).mockImplementationOnce(async () => {
      abortController.abort();
      throw new Error("aborted");
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      totalTokens: 150_000,
      totalTokensFresh: true,
    };

    const result = await handleCompactCommand(
      buildFlushCompactParams("/compact", sessionEntry, {
        opts: { abortSignal: abortController.signal },
      }),
      true,
    );

    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
    expect(result?.sessionCompaction).toEqual({
      compacted: false,
      reason: "command invocation closed",
    });
  });

  it("does not compact when the session changes under the memory flush", async () => {
    const order: CallOrder = [];
    recordCallOrder(order);
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      totalTokens: 150_000,
      totalTokensFresh: true,
    };
    let reads = 0;
    vi.mocked(prepareCurrentSessionEntry).mockImplementation(async ({ expected }) => {
      reads += 1;
      if (reads > 1) {
        return undefined;
      }
      return { entry: { ...sessionEntry, ...expected }, assertCurrent() {}, release() {} };
    });

    const result = await handleCompactCommand(
      buildFlushCompactParams("/compact", sessionEntry),
      true,
    );

    expect(order).toEqual(["flush"]);
    expect(result?.sessionCompaction).toEqual({
      compacted: false,
      reason: "command session changed",
    });
  });
});

describe("handleCompactCommand memory flush gate (real runMemoryFlushIfNeeded)", () => {
  const flushPlan: MemoryFlushPlan = {
    softThresholdTokens: 4_000,
    forceFlushTranscriptBytes: 1_000_000_000,
    reserveTokensFloor: 20_000,
    prompt: "Pre-compaction memory flush.\nNO_REPLY",
    systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
    relativePath: "memory/2026-10-07.md",
  };
  let rootDir: string;

  beforeEach(() => {
    resetCompactCommandMocks();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearMemoryPluginState();
    registerMemoryCapability("memory-core", { flushPlanResolver: () => flushPlan });
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compact-flush-gate-"));
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearMemoryPluginState();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("skips the flush when this compactionCount was already flushed, then compacts", async () => {
    let flushOutcome: string | undefined;
    let flushError: unknown;
    vi.mocked(runMemoryFlushIfNeeded).mockImplementationOnce(async (params) => {
      try {
        const flushed = await runMemoryFlushIfNeededActual(params);
        flushOutcome = flushed.outcome;
        return flushed;
      } catch (error) {
        flushError = error;
        throw error;
      }
    });
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { tokensBefore: 190_000, tokensAfter: 9_000 },
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      totalTokens: 190_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 24,
      memoryFlush: { kind: "succeeded", compactionCount: 24 },
    };
    serveCurrentEntry(sessionEntry);
    const result = await handleCompactCommand(
      buildFlushCompactParams("/compact", sessionEntry, {
        storePath: path.join(rootDir, "sessions.json"),
        workspaceDir: path.join(rootDir, "workspace"),
      }),
      true,
    );

    expect(vi.mocked(runMemoryFlushIfNeeded)).toHaveBeenCalledOnce();
    expect(flushError).toBeUndefined();
    expect(flushOutcome).toBe("skipped");
    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledOnce();
    expect(result?.sessionCompaction?.compacted).toBe(true);
  });

  it("attempts the flush when the last flush belongs to an older compaction", async () => {
    let flushOutcome: string | undefined;
    vi.mocked(runMemoryFlushIfNeeded).mockImplementationOnce(async (params) => {
      const flushed = await runMemoryFlushIfNeededActual(params);
      flushOutcome = flushed.outcome;
      return flushed;
    });
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { tokensBefore: 190_000, tokensAfter: 9_000 },
    });
    // Mirrors the observed gap: compaction #24 ran, but the last flush was for #23.
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      totalTokens: 190_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 24,
      memoryFlush: { kind: "succeeded", compactionCount: 23 },
    };
    serveCurrentEntry(sessionEntry);
    const result = await handleCompactCommand(
      buildFlushCompactParams("/compact", sessionEntry, {
        storePath: path.join(rootDir, "sessions.json"),
        workspaceDir: path.join(rootDir, "workspace"),
      }),
      true,
    );

    // The gate passed; without a real transcript the attempt cannot complete, and
    // the compact command must still proceed.
    expect(vi.mocked(runMemoryFlushIfNeeded)).toHaveBeenCalledOnce();
    expect(flushOutcome).not.toBe("skipped");
    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledOnce();
    expect(result?.sessionCompaction?.compacted).toBe(true);
  });
});
