import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIdleTimeout } from "../src/timeout.js";

describe("startIdleTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires after idleMs of silence", () => {
    const onFire = vi.fn();
    startIdleTimeout({ idleMs: 1000, onFire });
    vi.advanceTimersByTime(999);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledWith("idle");
  });

  it("touch() resets the idle countdown — an active child never trips it", () => {
    const onFire = vi.fn();
    const t = startIdleTimeout({ idleMs: 1000, onFire });
    // Produce output every 900ms for a long time; idle window never elapses.
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(900);
      t.touch();
    }
    expect(onFire).not.toHaveBeenCalled();
    // Then go silent past the window.
    vi.advanceTimersByTime(1000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith("idle");
  });

  it("hard ceiling fires regardless of activity and does NOT reset on touch", () => {
    const onFire = vi.fn();
    const t = startIdleTimeout({ idleMs: 1000, hardMs: 5000, onFire });
    // Keep touching so the idle timer never trips; the hard ceiling still fires at 5000.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(500);
      t.touch();
    }
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith("hard");
  });

  it("fires at most once (idle then hard never double-fires)", () => {
    const onFire = vi.fn();
    startIdleTimeout({ idleMs: 1000, hardMs: 2000, onFire });
    vi.advanceTimersByTime(5000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith("idle"); // idle (1000) beats hard (2000)
  });

  it("clear() cancels both timers — nothing fires after exit", () => {
    const onFire = vi.fn();
    const t = startIdleTimeout({ idleMs: 1000, hardMs: 2000, onFire });
    t.clear();
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("touch() after firing is inert", () => {
    const onFire = vi.fn();
    const t = startIdleTimeout({ idleMs: 1000, onFire });
    vi.advanceTimersByTime(1000);
    expect(onFire).toHaveBeenCalledTimes(1);
    t.touch();
    vi.advanceTimersByTime(10_000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("hardMs of 0/undefined means no ceiling", () => {
    const onFire = vi.fn();
    const t = startIdleTimeout({ idleMs: 1000, hardMs: 0, onFire });
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(900);
      t.touch();
    }
    expect(onFire).not.toHaveBeenCalled();
  });
});
