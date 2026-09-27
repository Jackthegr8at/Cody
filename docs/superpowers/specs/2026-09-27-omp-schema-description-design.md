# OMP Settings Schema Description Getter Resilience

- Date: 2026-09-27
- Status: Approved for implementation on 2026-09-27.

## Problem

The installed OMP 18.3.5 settings registry contains a lazily computed optional
description for `tui.codexResetFireworks`. Reading it calls `formatKeyHint`, but
Cody's bounded source bridge does not preserve that helper's relative
re-export. The resulting exception escapes schema normalization, where Cody
converts the entire schema to `null`; the settings page then shows its generic
schema-unavailable warning.

## Design

Treat an OMP setting description as optional metadata that may fail to
evaluate. Read the description defensively: preserve it when it evaluates to a
string; when its getter throws, omit only that description and keep normalizing
the setting and the rest of the schema. Keep the existing outer failure path
for errors that prevent required schema data from being read.

Do not expand the package-source bridge or evaluate additional OMP/TUI runtime
modules. The selected boundary is the optional description field, not the
settings registry itself.

## Verification

- Add a regression proving a throwing description getter does not discard its
  setting or invalidate the schema.
- Retain coverage that ordinary string descriptions survive normalization.
- Run the package-backed OMP schema test and focused settings-schema tests.
- Confirm the 18.3.5 schema includes `tui.codexResetFireworks` even when its
  description cannot be evaluated.

## Out of scope

- Changing OMP or its installed package.
- Changing labels, defaults, setting visibility, or persisted values.
