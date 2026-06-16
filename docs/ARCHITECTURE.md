# frites: Architecture & Plan

> **This document has moved.** The architecture and design content now lives in the
> structured docs under [docs/](README.md). This page is kept as a compatibility
> redirect so existing links keep resolving. The full original text remains in git history.

Start at the [architecture overview](architecture/overview.md), or jump to the section you were
looking for:

## 2.4 / 2.5 Child auth & billing modes

Moved to [Auth & billing](product/auth-and-billing.md).

## 4. Safety floor

Moved to [Safety model](product/safety-model.md). Engine-level enforcement and isolation are
covered in [Agents & runners](architecture/agents-and-runners.md) and
[Isolation](architecture/isolation.md).

## 8. Current implementation status

Moved to [Current status](roadmap/current-status.md).

## Everything else

- System shape and high-level decisions → [Architecture overview](architecture/overview.md)
- Transparent proxy internals → [Gateway](architecture/gateway.md)
- Worktree/MCP internals → [MCP worktree mode](architecture/mcp-worktree-mode.md)
- Engine, oracle, reconciliation → [Core engine](architecture/core-engine.md)
- Request/response flows → [Data flow](architecture/data-flow.md)
- Fan-out scoping → [Fan-out scope](concepts/fan-out-scope.md)
- Risks, hardening gaps, tradeoffs → [Risks & tradeoffs](architecture/risks-and-tradeoffs.md)
