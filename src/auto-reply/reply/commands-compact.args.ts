// Dependency-light /compact argument parsing shared by chat commands and the Control UI.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

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
