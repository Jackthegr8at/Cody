# Cody upstream integration ledger

This ledger tracks reviewed commits from `nphil/Cody` that are integrated into
the maintained fork. Keep OMPweb port decisions in the separate OMPweb port
ledger.

## Tracking cursor

- Upstream branch: `main`
- Last reviewed commit: `02d626f207c08e7d91af51976ca2c36b05659db5` (`0.42.1`)
- Reviewed on: `2026-09-27`
- Integration branch: `codex/integrate-0.42.1` (isolated worktree)
- Maintained base: `89b58b0cabf1e5aa9797b542748068c6aa795eea` on
  `origin/codex/maintained`
- State: upstream 0.42.0–0.42.1 is integrated and validated locally in the
  isolated worktree; this integration is not committed, pushed, or deployed.
  The prior `D:\git\Cody-0.40` and `D:\git\Cody-0.41` integrations remain
  untouched.

## Reviewed commits

| Upstream commit | Change | Decision | Integration notes |
| --- | --- | --- | --- |
| `f8c7401` | 0.40.0 thinking summary reliability and plain-language preference | Integrate | Merged the isolated engine setup, summary retry/finalization behavior, preference, translations, and tests. Resolved the only content conflict in `components/MessageView.tsx`, retaining the fork's finalized-reply gating and adding the upstream plain-language cache key and request option. |
| `d99992d` | 0.41.0 queued-message reliability, refusal choice, input dock, engine 18.3 | Integrate | Added the durable, ID-based outbox and pending-input/refusal flows. Reconciled `ChatInput`, `ChatWindow`, `SessionSidebar`, and `useAgentSession`; retained the local queued-delete confirmation, distinct steer/follow-up behavior, dismissible notices, and desktop host-tool/URI registration and activity reporting. |
| `d6afd96` | 0.41.1 immediate delivery and stream recovery | Integrate | Ported the delivery/retry and event-stream liveness updates plus RPC state-cache invalidation, keeping the maintained desktop bridge and live-notice behavior in the overlapping hook and RPC manager. |
| `cc0beab` | 0.41.2 subagent visibility and scale | Integrate | Ported the subagent/session-list updates and reconciled awaiting-input indicators with the maintained desktop activity callback. |
| `34f8359` | 0.42.0 steer interrupts, faster sends, bounded checkpoints, and lighter one-shot jobs | Integrate | Reconciled the composer, session hook, RPC manager, checkpoint store, and OMP schema. Upstream `steer_now` retains the held-follow-up-to-steer behavior and also handles an already-handed-off steer. Kept Windows Git behavior and Cody's activity/notification paths. |
| `7ecacfd` | Test runner cleans up temporary files | Integrate | `npm test` now runs under a private temporary directory and removes it afterward. |
| `02d626f` | 0.42.1 prunes old engine screenshots | Integrate | Added daily cleanup for only recognized OMP screenshot/helper-stderr names older than seven days, with focused allowlist/age tests. |

## Preservation review

The 0.41 commits do not change the provider settings page; its account rename
and permanent-removal controls remain present in `ProviderDetail.tsx`. The
existing Windows/desktop bridge and taskbar work, model pagination, and
notification behavior remain on the maintained `a1ec0a6` base and in the
isolated integration. Upstream's outbox UI is reconciled with the maintained
delete confirmation and steer/follow-up distinction. No Hermes work was added.
The earlier 0.40 integration is the starting patch, and its checkout was not
modified.

## Preservation review — 0.42.1

The 0.42.1 upstream patch does not touch `ProviderDetail.tsx`, Cody's Windows
bridge/taskbar files, model pagination, or the provider rename/permanent-delete
flows; these remain unchanged from the maintained base. In overlapping stream
files, the native activity and notice reporting stays in place. The settings
schema retains the maintained export used by tests and safely reads each
optional OMP UI getter independently. Checkpoints keep the fork's Git line
ending options on both normal and low-priority paths. No Hermes work was added.

## Validation — 0.42.1 integration

- Focused ChatInput, session, RPC, checkpoint, OMP schema/temp-file, and
  one-shot tests: 118 passed, 0 failed, 14 skipped (Windows POSIX fixtures or
  OMP package not extracted).
- TypeScript `--noEmit --incremental false`: passed.
- ESLint: zero errors, 25 warnings.
- Full suite: the six `isolated-agent-dir` symlink tests cannot run on this
  Windows host because symlink creation is denied (`EPERM`).
- Production Next.js webpack build: passed, including TypeScript and static
  page generation.

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
- Linux Node 22 full suite: 1,904 passed, 3 failed, 4 cancelled, and 18
  skipped. The remaining route-guard/provider, installer, and RPC-timeout
  failure categories also reproduced on the maintained `a1ec0a6` baseline;
  all 9 isolated-agent-directory tests passed on Linux.
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

## 0.41.2 Dev Hub deployment

- Date: `2026-09-27`
- Source commit: `3f85a16c71b116481b7bde79ec9486e302ed7b99`
- Container: `devhub-cody`, image `cody:upstream-20260927-0.41.2-r1`
- Image ID: `sha256:e397a88ddec1c8bf2b5ba2220b21408630003cc418dfc96a1417de2a092bde26`
- Source archive SHA-256:
  `12ce1d1c51f540346c024aea7bf53f497aba82c006f1a02d25f8c9ac2355a471`
- Health: healthy, zero restarts; `/login` returned 200 and `/` returned 307
  at `192.168.0.214:30177`.
- Preserved the existing eight bind mounts, three Docker networks, and LAN port.
- Compose backup: `/opt/devhub/services/cody/compose.yaml.bak-upstream-20260927-r1`
- Build reported six npm audit advisories, including a critical Next.js advisory;
  review and dependency update should be tracked separately from this integration.
