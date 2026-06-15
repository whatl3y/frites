// A tiny single-consumer progress channel between the running council turn and the SSE writer.
//
// The turn (runAgentTurn) starts executing the moment its promise is created — which is BEFORE
// the stream handler has written its headers and attached a listener. So early messages must not
// be lost: push() buffers until a listener attaches, then onMessage() replays the buffer and
// streams everything live thereafter. Node is single-threaded, so there are no races here.

export interface ProgressSink {
  /** Record a human-readable progress line (delivered live, or buffered until a listener attaches). */
  push(text: string): void;
  /** Attach the single consumer. Replays anything buffered so far, then streams live. */
  onMessage(cb: (text: string) => void): void;
  /** Stop delivery; further push() calls are dropped. */
  end(): void;
  readonly ended: boolean;
}

export function createProgressSink(): ProgressSink {
  const buffer: string[] = [];
  let listener: ((text: string) => void) | null = null;
  let ended = false;

  return {
    get ended() {
      return ended;
    },
    push(text: string): void {
      if (ended) return;
      if (listener) listener(text);
      else buffer.push(text);
    },
    onMessage(cb: (text: string) => void): void {
      listener = cb;
      if (buffer.length) {
        const pending = buffer.splice(0);
        for (const t of pending) cb(t);
      }
    },
    end(): void {
      ended = true;
      listener = null;
      buffer.length = 0;
    },
  };
}
