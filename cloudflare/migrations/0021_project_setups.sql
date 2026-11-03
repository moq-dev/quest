-- A repository without Quest files that a maintainer chose to enroll: the
-- App's setup pull request, which writes what `quest init` would. The project
-- is enrolled, setting up, until that pull request merges, when the project
-- moves to github_projects as enabled and this row goes. A closed pull request
-- leaves the row, offering a retry or a disconnect. It never grants authority:
-- opening, retrying, and enabling each recheck GitHub live.
CREATE TABLE github_project_setups (
  id INTEGER PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  installation INTEGER NOT NULL,
  -- The branch's commit kix last published, and one it is moving the branch to,
  -- so a retry recognizes kix's own branch after an interrupted update.
  head TEXT,
  pending TEXT,
  pull INTEGER,
  state TEXT NOT NULL CHECK(state IN ('open','closed')),
  -- Why the merged setup could not enable contributions, until a retry succeeds.
  failure TEXT,
  enrolledBy TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX github_project_setups_user ON github_project_setups(enrolledBy);
