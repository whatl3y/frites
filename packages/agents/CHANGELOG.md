# @frites/agents

## 0.0.3

### Patch Changes

- Backend failure classification + provider suppression with cross-provider failover, a raised default fan-out cap (5→10), and council fallbacks when children or synthesis fail. Includes audit fixes: classification reads the error channel only (an answer that merely mentions "429"/"usage limit"/"403" can no longer suppress a healthy provider), synthesis-failure fallback prefers a side-effect-free answer and never auto-executes an unvetted tool, and background/utility turns stay pinned to their cheap model instead of escalating to a premium provider.
  - @frites/core@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies
  - @frites/core@0.0.2
