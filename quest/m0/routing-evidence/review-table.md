# [XS] Restore the review efforts

## Goal

`quest review`'s size reviewer runs Sol at medium for XS, medium for S,
high for M, xhigh for L, and xhigh for XL. Opus, which reviews only what Sol
wrote last, keeps its efforts. `quest review --help`, the README, and
[the model check](/quest/m1/model-check.md)'s list of review efforts match.

## Plan

Decided 2026-11-11 (user, /quest-plan,
[routing evidence](/quest/m0/routing-evidence/README.md)): this restores the
review efforts in place before the
[token waste](/quest/m0/token-waste/README.md) cut of 2026-11-05 and raises
XS from low. Sol low found 2 findings across 68 XS branches. M at medium
found 0.41 per branch, against 1.44 at xhigh before the cut, with about
90% of findings fixed. A step up costs about $0.10 to $0.47 more per PR.
[The shadow review](/quest/m0/routing-evidence/shadow-review.md) A/B tests
the change by reviewing one step below it.
