import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { computeNextProfileUsageStats, resolveBillingLockout } from "./usage-failure-state.js";

describe("auth.cooldowns.billingLockout", () => {
  const now = 1_700_000_000_000;

  it("defaults to true and only false turns the lockout off", () => {
    expect(resolveBillingLockout(undefined)).toBe(true);
    expect(resolveBillingLockout({} as OpenClawConfig)).toBe(true);
    expect(resolveBillingLockout({ auth: {} } as OpenClawConfig)).toBe(true);
    expect(
      resolveBillingLockout({ auth: { cooldowns: { billingLockout: true } } } as OpenClawConfig),
    ).toBe(true);
    expect(
      resolveBillingLockout({ auth: { cooldowns: { billingLockout: false } } } as OpenClawConfig),
    ).toBe(false);
  });

  it("billing lands in the disabled lane by default", () => {
    const stats = computeNextProfileUsageStats({ existing: {}, now, reason: "billing" });
    expect(stats.disabledReason).toBe("billing");
    expect(stats.disabledUntil).toBe(now + 10 * 60 * 1000);
    expect(stats.cooldownUntil).toBeUndefined();
    expect(stats.failureCounts?.billing).toBe(1);
  });

  it("billingLockout=false demotes billing to the regular short cooldown", () => {
    const stats = computeNextProfileUsageStats({
      existing: {},
      now,
      reason: "billing",
      billingLockout: false,
    });
    expect(stats.disabledUntil).toBeUndefined();
    expect(stats.disabledReason).toBeUndefined();
    expect(stats.cooldownReason).toBe("billing");
    expect(stats.cooldownUntil).toBe(now + 30_000);
    expect(stats.failureCounts?.billing).toBe(1);
  });

  it("billingLockout=false leaves auth_permanent in the disabled lane", () => {
    const stats = computeNextProfileUsageStats({
      existing: {},
      now,
      reason: "auth_permanent",
      billingLockout: false,
    });
    expect(stats.disabledReason).toBe("auth_permanent");
  });
});
