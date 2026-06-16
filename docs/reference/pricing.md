# Pricing

frites can estimate per-child spend from a config-driven, per-model rate table. Pricing is **opt-in**:
there are no built-in rates. When you supply rates, frites uses them to fill in spend figures that a
backend doesn't self-report.

This page documents the pricing model itself. The `pricing` config key is defined in
[configuration](configuration.md).

## Authoritative vs. estimated spend

How spend is reported depends on the backend:

| Backend | Spend source | Display |
|---|---|---|
| **claude** (`claude -p`) | The CLI self-reports actual cost. | Authoritative — shown as `$0.0123`. |
| **codex** (ChatGPT backend) | Reports no cost. | Estimated from the `pricing` table when rates exist — shown with a leading tilde, `~$0.0123`. |

Without a `pricing` table, codex spend reads as `cost n/a` (and previously made codex look "free"
next to claude). Supplying rates replaces those blanks with estimates. Authoritative claude figures
are never overwritten by estimates — the reported cost always wins, and the estimate is only computed
when the backend reported none.

## The rate table

The `pricing` config key is a map of model → rates, in **dollars per million tokens** ($/Mtok):

```json
{
  "pricing": {
    "gpt-5.5": {
      "inputPerMtok": 1.25,
      "outputPerMtok": 10.0,
      "cachedInputPerMtok": 0.125,
      "cacheWritePerMtok": 1.5625
    }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `inputPerMtok` | yes | Rate for fresh (uncached) input tokens. |
| `outputPerMtok` | yes | Rate for output tokens (reasoning-inclusive). |
| `cachedInputPerMtok` | no | Rate for cached/reused input (cache reads). Defaults to `inputPerMtok` when omitted. |
| `cacheWritePerMtok` | no | Rate for cache-write (creation) input — claude only. Defaults to `inputPerMtok` when omitted. |

## How a rate is selected

For a given model name, frites resolves the table entry as follows:

1. **Exact match** wins — if the table has a key equal to the model name, that entry is used.
2. Otherwise a **prefix match in either direction** — a table key is used if the model name starts
   with the key **or** the key starts with the model name.

The bidirectional prefix rule means a coarse key like `"gpt-5.5"` covers a fully versioned model id
like `"gpt-5.5-2026-…"`, and a fully versioned key still matches a bare alias. If nothing fits, no
rate is found and that child's spend is left unestimated.

## How an estimate is computed

frites normalizes usage to a provider-agnostic shape before estimating:

- `inputTokens` is the **grand total** input (all categories summed).
- `cacheReadTokens` is the cached/reused portion of that total.
- `cacheCreationTokens` is the cache-write portion (claude only).
- `outputTokens` is reasoning-inclusive on both providers.

The **fresh** (newly billed) input is `inputTokens − cacheReadTokens − cacheCreationTokens` (floored
at zero). The estimate is then:

```
fresh * inputPerMtok
  + cacheReads * (cachedInputPerMtok ?? inputPerMtok)
  + cacheWrites * (cacheWritePerMtok ?? inputPerMtok)
  + output * outputPerMtok
```

divided by 1,000,000. When no rates are supplied for the model, the estimate is `undefined` —
estimation is strictly opt-in.

## Where estimates surface

Estimated spend appears in the same places authoritative cost does — the live per-agent progress
line, the per-turn council recap, and the gateway log — always marked with a `~` so estimates are
visually distinct from claude's reported figures. The same estimator (`@frites/core`) is the single
source of truth used by both the gateway's answer-council path and the worktree engine path.

See [cost telemetry](../concepts/cost-telemetry.md) for how these figures are displayed during a
turn, and [configuration](configuration.md) for the `pricing` key alongside the other config keys.
