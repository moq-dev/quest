# Donated review and check automation

## Goal

After implementation contributions work, projects can accept separately
authorized agent reviews and CI capacity using ordinary GitHub interfaces.

## Plan

Decided 2026-10-13: C1 first, then C2. Existing repository checks remain part
of implementation; this epic adds independent donated review and CI jobs.
No custom review database or git-note approval protocol is introduced.

## Required

- [Agent reviews](/quest/m2/automation/review.md) - attributed, advisory GitHub reviews
- [Donated checks](/quest/m2/automation/checks.md) - repository-defined check execution with explicit trust
- [Nix cache](/quest/m2/automation/cache.md) - optional main-only signed build cache
