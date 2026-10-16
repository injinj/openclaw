// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { executeSlashCommand } from "./chat-command-executor.ts";

function createCompactHarness(result: unknown = { ok: true, compacted: true }) {
  const request = vi.fn(async (method: string) => {
    if (method !== "sessions.compact") {
      throw new Error(`unexpected method: ${method}`);
    }
    return result;
  });
  const client = createTestGatewayClient(request);
  const snapshot = {
    client,
    hello: sessionMutationGatewayHello(),
    phase: "connected" as const,
  };
  const sessions = createTestSessionCapability({
    snapshot,
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  return { request, client: client as GatewayBrowserClient, sessions, snapshot };
}

async function runCompact(args: string, options: { sessionKey?: string; agentId?: string } = {}) {
  const harness = createCompactHarness();
  const result = await executeSlashCommand(
    harness.client,
    options.sessionKey ?? "main",
    "compact",
    args,
    {
      sessions: harness.sessions,
      sessionAccessSnapshot: harness.snapshot,
      ...(options.agentId ? { agentId: options.agentId } : {}),
    },
  );
  return { result, request: harness.request };
}

it.each(["--no-flush", "--noflush", "noflush", "NoFlush", "--NO-FLUSH"])(
  "passes skipMemoryFlush to sessions.compact for %s",
  async (token) => {
    const { result, request } = await runCompact(token, {
      sessionKey: "global",
      agentId: "work",
    });

    expect(result).toEqual({ action: "refresh" });
    expect(request).toHaveBeenCalledWith("sessions.compact", {
      key: "global",
      agentId: "work",
      skipMemoryFlush: true,
    });
  },
);

it("strips the opt-out flag from surrounding compact text", async () => {
  const { request } = await runCompact("focus on --no-flush the API decisions");

  expect(request).toHaveBeenCalledWith("sessions.compact", {
    key: "main",
    skipMemoryFlush: true,
  });
});

it("keeps the default memory flush when compact arguments do not opt out", async () => {
  const { result, request } = await runCompact("explain the noflush-mode bug");

  expect(result).toEqual({ action: "refresh" });
  expect(request).toHaveBeenCalledWith("sessions.compact", { key: "main" });
});

it("keeps the default memory flush for a bare /compact", async () => {
  const { request } = await runCompact("");

  expect(request).toHaveBeenCalledWith("sessions.compact", { key: "main" });
});

it("reports a skipped compaction normally when the flush was opted out", async () => {
  const harness = createCompactHarness({ ok: true, compacted: false, reason: "Already compacted" });
  const result = await executeSlashCommand(harness.client, "main", "compact", "--no-flush", {
    sessions: harness.sessions,
    sessionAccessSnapshot: harness.snapshot,
  });

  expect(result).toEqual({
    content: t("chat.commandResults.compaction.skippedWithReason", { reason: "Already compacted" }),
    action: "refresh",
  });
  expect(harness.request).toHaveBeenCalledWith("sessions.compact", {
    key: "main",
    skipMemoryFlush: true,
  });
});
