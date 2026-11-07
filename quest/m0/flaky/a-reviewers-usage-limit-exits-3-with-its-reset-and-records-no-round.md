# [S] Fix the reviewer usage-limit test

## Goal

Fix `test/review.test.ts > a reviewer's usage limit exits 3 with its reset,
and records no round` so it reliably passes within its timeout, or delete
the test. Remove its skip when the fix lands.

The test exceeded its 5000 ms timeout in merge-group runs, and passed in
isolation on the same scratch merge. Failure jobs:

- [Earlier queue build](https://github.com/moq-dev/quest/actions/runs/42354876012/job/128350646309)
- [Earlier queue result](https://github.com/moq-dev/quest/actions/runs/42354876012/job/128352135869)
- [Current queue build](https://github.com/moq-dev/quest/actions/runs/42357807171/job/128359649721)
- [Current queue result](https://github.com/moq-dev/quest/actions/runs/42357807171/job/128361023143)
