# Cody upstream integration ledger

This ledger tracks reviewed commits from `nphil/Cody` that are integrated into
the maintained fork. Keep OMPweb port decisions in the separate OMPweb port
ledger.

## Tracking cursor

- Upstream branch: `main`
- Last reviewed commit: `cc0beab4f2e1d9918ca991f0eaf87eb2107683de` (`0.41.2`)
- Reviewed on: `2026-09-27`
- Integration branch: `codex/integrate-0.41`, based on maintained `a1ec0a6`
- State: integration is committed locally on `codex/integrate-0.41` for
  promotion; not pushed or deployed. The prior `D:\git\Cody-0.40` integration
  remains untouched.

## Reviewed commits

| Upstream commit | Change | Decision | Integration notes |
| --- | --- | --- | --- |
| `f8c7401` | 0.40.0 thinking summary reliability and plain-language preference | Integrate | Merged the isolated engine setup, summary retry/finalization behavior, preference, translations, and tests. Resolved the only content conflict in `components/MessageView.tsx`, retaining the fork's finalized-reply gating and adding the upstream plain-language cache key and request option. |
| `d99992d` | 0.41.0 queued-message reliability, refusal choice, input dock, engine 18.3 | Integrate | Added the durable, ID-based outbox and pending-input/refusal flows. Reconciled `ChatInput`, `ChatWindow`, `SessionSidebar`, and `useAgentSession`; retained the local queued-delete confirmation, distinct steer/follow-up behavior, dismissible notices, and desktop host-tool/URI registration and activity reporting. |
| `d6afd96` | 0.41.1 immediate delivery and stream recovery | Integrate | Ported the delivery/retry and event-stream liveness updates plus RPC state-cache invalidation, keeping the maintained desktop bridge and live-notice behavior in the overlapping hook and RPC manager. |
| `cc0beab` | 0.41.2 subagent visibility and scale | Integrate | Ported the subagent/session-list updates and reconciled awaiting-input indicators with the maintained desktop activity callback. |

## Preservation review

The 0.41 commits do not change the provider settings page; its account rename
and permanent-removal controls remain present in `ProviderDetail.tsx`. The
existing Windows/desktop bridge and taskbar work, model pagination, and
notification behavior remain on the maintained `a1ec0a6` base and in the
isolated integration. Upstream's outbox UI is reconciled with the maintained
delete confirmation and steer/follow-up distinction. No Hermes work was added.
The earlier 0.40 integration is the starting patch, and its checkout was not
modified.

## Validation — 0.41 integration

- Lockfile dependency install completed (`npm ci --ignore-scripts`): 1,102
  packages.
- TypeScript `--noEmit --incremental false`: passed.
- ESLint: zero errors, 25 warnings.
- Focused ChatInput, useAgentSession, and project-ordering tests: 52/52 passed.
- Full unit/component suite: six `isolated-agent-dir` tests fail on this
  Windows host because file/directory symlink creation is denied (`EPERM`);
  the remaining tests pass. Re-run those symlink checks on a host with symlink
  privileges before release.
- Production Next.js webpack build: passed, including static page generation.

## Previous 0.40 validation (historical)

- TypeScript: passed with `--noEmit --incremental false`.
- Full ESLint: zero errors, 28 warnings.
- Focused Distill, MessageView, and isolated-agent-directory tests passed on
  Linux Node 22.
- Full suite: 1,879 passed, 6 failed, 4 cancelled, 18 skipped. Engine-route,
  installer, and RPC-timeout failures also reproduce on the 0.39 baseline;
  the visibility test files pass when run by themselves.
- Production Docker build passed, including Next.js compilation, TypeScript,
  and static generation.

## Previous 0.40 Dev Hub deployment (historical)

- Date: `2026-09-26`
- Container: `devhub-cody`, image `cody:upstream-20260926-r1`
- Image ID: `sha256:5aefb595ab90e407a6f63578b920d6a43c9a0ea45ed1aef4b640a15e2f1b8867`
- Source archive SHA-256: `252d573034945de8028ae7d1197ecd4a7981c42a8337bbb1c00743e3a22e986f`
- Health: healthy, zero restarts; `/login` returned 200 and `/` returned 307
  at `192.168.0.214:30177`.
- Preserved the existing eight bind mounts, three Docker networks, and LAN port.
- Compose backup: `/opt/devhub/services/cody/compose.yaml.bak-upstream-20260926-r1`
- Rollback image remains available: `cody:devhub-0.38.0-20260925-toast-r1`.
