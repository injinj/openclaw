import { expect, test } from "vitest";
import { validateSessionsCompactParams } from "./index.js";

test("sessions.compact accepts the optional memory flush opt-out", () => {
  expect(validateSessionsCompactParams({ key: "global", agentId: "work" })).toBe(true);
  expect(validateSessionsCompactParams({ key: "agent:main:main", skipMemoryFlush: true })).toBe(
    true,
  );
  expect(
    validateSessionsCompactParams({ key: "agent:main:main", skipMemoryFlush: false, maxLines: 20 }),
  ).toBe(true);
});

test("sessions.compact rejects malformed memory flush opt-outs", () => {
  expect(validateSessionsCompactParams({ key: "agent:main:main", skipMemoryFlush: "true" })).toBe(
    false,
  );
  expect(validateSessionsCompactParams({ key: "agent:main:main", noFlush: true })).toBe(false);
});
