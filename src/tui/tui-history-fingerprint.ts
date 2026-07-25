import { asString, extractTextFromMessage } from "./tui-formatters.js";

/**
 * Fingerprint of a fully rendered history payload. loadHistory() clears the
 * chat log and re-renders every message; because the TUI renders into normal
 * terminal scrollback, that re-prints the entire session. Server-side history
 * mutations that do not change the rendered transcript (session compaction,
 * duplicate reload triggers) would spam the whole conversation again — so
 * callers compare fingerprints and skip the re-render when the incoming
 * payload renders identically to what is already displayed.
 */
export function fingerprintHistory(params: {
  messages: unknown[];
  sessionKey: string;
  showTools: boolean;
  showThinking: boolean;
}): string {
  const { messages, sessionKey, showTools, showThinking } = params;
  /* FNV-1a over the fields that influence rendering; cheap + stable */
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193);
  };
  mix(`${sessionKey}|${showTools ? "t" : ""}${showThinking ? "k" : ""}`);
  let count = 0;
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const message = entry as Record<string, unknown>;
    const role = asString(message.role, "");
    if (role === "toolResult") {
      if (!showTools) {
        continue;
      }
      mix(`r|${asString(message.toolCallId, "")}|${asString(message.toolName, "")}`);
      count++;
      continue;
    }
    const text = extractTextFromMessage(message, {
      includeThinking: showThinking,
    });
    if (!text) {
      continue;
    }
    mix(`${role}|${text}`);
    count++;
  }
  return `${count}:${(h >>> 0).toString(16)}`;
}
