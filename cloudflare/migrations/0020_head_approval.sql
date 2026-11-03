-- A maintainer's approval of one exact pull request head, such as one kix
-- pushed, so its iterate and merge jobs run on any runner although not every
-- commit carries a maintainer signature. One row per pull request: approving
-- a newer head replaces it, and a head that moves no longer matches it. The
-- approver's current maintain or admin role is rechecked each time it counts.
CREATE TABLE head_approvals (
  repository INTEGER NOT NULL REFERENCES github_projects(id) ON DELETE CASCADE,
  pull INTEGER NOT NULL,
  head TEXT NOT NULL,
  approver TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  approvedAt INTEGER NOT NULL,
  PRIMARY KEY(repository, pull)
);
