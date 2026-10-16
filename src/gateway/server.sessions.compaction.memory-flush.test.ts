/**
 * sessions.compact runs the pre-compaction memory flush like chat /compact does.
 */
import { beforeEach, expect, test, vi } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry as loadAccessorSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { embeddedRunMock, rpcReq } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

type MemoryRuntime = typeof import("../auto-reply/reply/agent-runner-memory.js");
type RunMemoryFlushIfNeeded = MemoryRuntime["runMemoryFlushIfNeeded"];
type MemoryFlushParams = Parameters<RunMemoryFlushIfNeeded>[0];
type MemoryFlushResult = Awaited<ReturnType<RunMemoryFlushIfNeeded>>;

const memoryFlushMocks = vi.hoisted(() => ({
  runMemoryFlushIfNeeded: vi.fn<(params: MemoryFlushParams) => Promise<MemoryFlushResult>>(),
}));

// mock-isolation: the flush gate and agent run are covered by agent-runner-memory tests;
// this suite checks only that sessions.compact drives the flush before compacting.
vi.mock("../auto-reply/reply/agent-runner-memory.js", async (importOriginal) => ({
  ...(await importOriginal<MemoryRuntime>()),
  runMemoryFlushIfNeeded: memoryFlushMocks.runMemoryFlushIfNeeded,
}));

// Load after the fixture mocks, during collection rather than the first RPC deadline.
import "./server-methods/sessions-compact.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

type CallOrder = Array<"flush" | "compact">;

async function createFlushCompactionSession(sessionId: string) {
  const sessionKey = "agent:main:main";
  const { storePath } = await createSessionStoreDir();
  const scope = { agentId: "main", sessionId, sessionKey, storePath };
  await upsertSessionEntryCore(
    scope,
    sessionStoreEntry(sessionId, {
      thinkingLevel: "low",
      authProfileOverride: "anthropic:work",
      chatType: "direct",
      groupChannel: "ops",
      space: "team",
    }),
  );
  await appendTranscriptEvent(scope, {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-06-19T12:00:00.000Z",
    cwd: "/tmp",
  });
  for (let index = 0; index < 2; index += 1) {
    await appendTranscriptMessage(scope, {
      cwd: "/tmp",
      message: { role: "user", content: `line-${index}`, timestamp: index },
      now: Date.parse(`2026-06-19T12:00:0${index}.000Z`),
    });
  }
  return { sessionKey, storePath, sessionId };
}

function recordCallOrder(order: CallOrder) {
  memoryFlushMocks.runMemoryFlushIfNeeded.mockImplementation(async (params) => {
    order.push("flush");
    return { sessionEntry: params.sessionEntry, outcome: "completed" };
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementation(async () => {
    order.push("compact");
    return {
      ok: true,
      compacted: true,
      result: {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 80,
      },
    };
  });
}

beforeEach(() => {
  memoryFlushMocks.runMemoryFlushIfNeeded.mockReset();
  memoryFlushMocks.runMemoryFlushIfNeeded.mockImplementation(async (params) => ({
    sessionEntry: params.sessionEntry,
    outcome: "skipped",
  }));
});

test("sessions.compact runs the memory flush before compacting with a session-derived follow-up", async () => {
  const { sessionKey, storePath, sessionId } =
    await createFlushCompactionSession("sess-compact-flush");
  const order: CallOrder = [];
  recordCallOrder(order);

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main" });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.payload).toMatchObject({ ok: true, key: sessionKey, compacted: true });
  } finally {
    ws.close();
  }

  expect(order).toEqual(["flush", "compact"]);
  expect(memoryFlushMocks.runMemoryFlushIfNeeded).toHaveBeenCalledOnce();
  const flushParams = memoryFlushMocks.runMemoryFlushIfNeeded.mock.calls[0]?.[0];
  expect(flushParams).toMatchObject({
    sessionKey,
    runtimePolicySessionKey: sessionKey,
    storePath,
    isHeartbeat: false,
    promptForEstimate: "",
    resolvedVerboseLevel: "off",
  });
  expect(flushParams?.sessionEntry?.sessionId).toBe(sessionId);
  expect(flushParams?.sessionStore?.[sessionKey]?.sessionId).toBe(sessionId);
  expect(flushParams?.followupRun).toMatchObject({
    prompt: "",
    memoryAudienceSenderIsOwner: false,
    run: {
      agentId: "main",
      sessionId,
      sessionKey,
      sessionFile: sessionKey,
      runtimePolicySessionKey: sessionKey,
      provider: expect.any(String),
      model: expect.any(String),
      authProfileId: "anthropic:work",
      chatType: "direct",
      groupChannel: "ops",
      groupSpace: "team",
      thinkLevel: "low",
      verboseLevel: "off",
      senderIsOwner: false,
    },
  });
  expect(flushParams?.followupRun.run.messageProvider).toBeUndefined();
  expect(flushParams?.followupRun.run.workspaceDir).toEqual(expect.any(String));
  expect(flushParams?.followupRun.run.timeoutMs).toBeGreaterThan(0);
  expect(flushParams?.defaultModel).toBe(flushParams?.followupRun.run.model);
  expect(
    loadAccessorSessionEntry({ agentId: "main", sessionKey, storePath, readConsistency: "latest" }),
  ).toMatchObject({
    sessionId,
    compactionCount: 1,
  });
});

test("sessions.compact skipMemoryFlush compacts without running the memory flush", async () => {
  const { sessionKey } = await createFlushCompactionSession("sess-compact-skip-flush");
  const order: CallOrder = [];
  recordCallOrder(order);

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main", skipMemoryFlush: true });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.payload).toMatchObject({ ok: true, key: sessionKey, compacted: true });
  } finally {
    ws.close();
  }

  expect(order).toEqual(["compact"]);
  expect(memoryFlushMocks.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
});

test("sessions.compact skipMemoryFlush=false still flushes", async () => {
  await createFlushCompactionSession("sess-compact-flush-explicit");
  const order: CallOrder = [];
  recordCallOrder(order);

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main", skipMemoryFlush: false });
    expect(response.ok, JSON.stringify(response)).toBe(true);
  } finally {
    ws.close();
  }

  expect(order).toEqual(["flush", "compact"]);
});

test("sessions.compact compacts anyway when the memory flush throws", async () => {
  const { sessionKey } = await createFlushCompactionSession("sess-compact-flush-throws");
  const order: CallOrder = [];
  recordCallOrder(order);
  memoryFlushMocks.runMemoryFlushIfNeeded.mockImplementationOnce(async () => {
    order.push("flush");
    throw new Error("flush model exploded");
  });

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main" });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.payload).toMatchObject({ ok: true, key: sessionKey, compacted: true });
  } finally {
    ws.close();
  }

  expect(order).toEqual(["flush", "compact"]);
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledOnce();
});

test("sessions.compact compacts anyway when the memory flush reports failure", async () => {
  await createFlushCompactionSession("sess-compact-flush-failed");
  const order: CallOrder = [];
  recordCallOrder(order);
  memoryFlushMocks.runMemoryFlushIfNeeded.mockImplementationOnce(async (params) => {
    order.push("flush");
    return { sessionEntry: params.sessionEntry, outcome: "failed" };
  });

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main" });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.payload).toMatchObject({ ok: true, compacted: true });
  } finally {
    ws.close();
  }

  expect(order).toEqual(["flush", "compact"]);
});

test("sessions.compact maxLines trimming never runs the memory flush", async () => {
  const { sessionKey } = await createFlushCompactionSession("sess-compact-trim-no-flush");
  const order: CallOrder = [];
  recordCallOrder(order);

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 1 });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.payload).toMatchObject({ ok: true, key: sessionKey, compacted: true, kept: 1 });
  } finally {
    ws.close();
  }

  expect(order).toEqual([]);
  expect(memoryFlushMocks.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
});
