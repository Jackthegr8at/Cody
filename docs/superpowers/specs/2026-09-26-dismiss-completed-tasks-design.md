# Dismiss completed composer tasks

## Goal

Let a user close the completed Tasks bar without waiting for another task list. Closing a list is a display preference, not deletion of the session's task history.

## Behavior

- Show a small, accessible X button in the composer Tasks header only when every top-level task is completed and the list is nonempty.
- Clicking X hides that Tasks panel immediately. It does not clear or alter the underlying task phases, plan overlay, or Subagents panel.
- Remember the dismissal in browser storage for the current session and task-list identity so a reload does not restore the same completed bar. A list with changed phase/task ids or content appears normally. If any task becomes incomplete, clear the dismissal so a subsequent completion can be shown again. Dismissals in one session do not affect another.
- The action is available when the panel is collapsed or expanded. The header's expand/collapse button and the X remain separate controls.
- If browser storage is unavailable, closing still works for the current render; it simply may not survive a reload.

## Implementation boundary

Pass the current session id to `ComposerPanels` and keep the display-only dismissal there (or in `TodoList` if that yields a simpler state boundary). Derive a stable fingerprint from phase and task identifiers/content, not React object identity. Preserve the engine-owned task state and existing subagent behavior. Use a visually quiet button with an accessible name such as “Dismiss completed tasks.”

## Verification

Check that X is absent for active or incomplete lists; clicking it hides only the completed Tasks panel; a remount/reload with the same session and list stays hidden; a changed list, a reopened incomplete list, and a different session display; and storage failures do not break the composer. Run focused component tests and TypeScript checks.
