/**
 * Reap a child that has gone SILENT, not one that's merely slow.
 *
 * The old design was a fixed wall-clock deadline: a child was SIGKILL'd `idleMs` after spawn no
 * matter what, so an exhaustive agentic run that was actively streaming events got killed mid-flight
 * (the "claude timed out after 600000ms" while it was still working). This is an *idle* timeout
 * instead — `touch()` (called on every chunk of child output) resets the countdown, so a child that
 * keeps producing output runs as long as it stays productive. Only genuine silence — a deadlock on
 * stdin, a stalled network read, an infinite loop with no output — trips it.
 *
 * `hardMs` is an OPTIONAL absolute ceiling (does NOT reset on output) as a secondary backstop for
 * the pathological "spinning forever while still emitting bytes" case. Off when undefined/0.
 *
 * `onFire` runs at most once, with whichever timer tripped first. After it fires, `touch()` is inert.
 */
export type TimeoutReason = "idle" | "hard";

export interface IdleTimeoutController {
  /** Call on any child output (stdout/stderr) to reset the idle countdown. */
  touch(): void;
  /** Cancel all timers — call when the child exits, errors, or is aborted. Idempotent. */
  clear(): void;
}

export function startIdleTimeout(opts: {
  idleMs: number;
  hardMs?: number;
  onFire: (reason: TimeoutReason) => void;
}): IdleTimeoutController {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;

  const clear = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    idleTimer = undefined;
    hardTimer = undefined;
  };

  const fire = (reason: TimeoutReason): void => {
    if (fired) return;
    fired = true;
    clear();
    opts.onFire(reason);
  };

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire("idle"), opts.idleMs);
  };

  armIdle();
  if (opts.hardMs && opts.hardMs > 0) {
    hardTimer = setTimeout(() => fire("hard"), opts.hardMs);
  }

  return {
    touch: () => {
      if (!fired) armIdle();
    },
    clear,
  };
}
