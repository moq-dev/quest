-- A delete job abandons the quest a pull request claims, as /quest-delete
-- does. SQLite cannot alter the workflow CHECK constraint, so the jobs table is
-- rebuilt. Dropping it cascades to its dependents, so their rows are set aside
-- and restored.
PRAGMA defer_foreign_keys = true;
CREATE TABLE jobs_rebuilt (
  id TEXT PRIMARY KEY NOT NULL,
  repository INTEGER NOT NULL REFERENCES github_projects(id) ON DELETE CASCADE,
  workflow TEXT NOT NULL CHECK(workflow IN ('plan','start','iterate','merge','delete','bootstrap')),
  target TEXT NOT NULL,
  revision TEXT NOT NULL,
  branch TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  trusted INTEGER NOT NULL CHECK(trusted IN (0,1)),
  pinRunner TEXT,
  pinAccount TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','completed','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  runner TEXT,
  account TEXT,
  session TEXT,
  lease INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
  cancel INTEGER NOT NULL DEFAULT 0 CHECK(cancel IN (0,1)),
  summary TEXT,
  result TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  head TEXT,
  pending TEXT,
  pendingAt INTEGER,
  pull INTEGER,
  continues TEXT REFERENCES jobs_rebuilt(id) ON DELETE SET NULL,
  idea TEXT,
  context TEXT,
  -- A merge or delete job's hold on its pull request: the ID of the timeline
  -- event that added the `quest:kix` label for it. Null once the label is
  -- released or was never added.
  hold TEXT,
  recheck INTEGER NOT NULL DEFAULT 1 CHECK(recheck IN (0,1))
);
INSERT INTO jobs_rebuilt(id,repository,workflow,target,revision,branch,actor,trusted,pinRunner,pinAccount,state,attempt,runner,account,session,lease,delivered,cancel,summary,result,createdAt,updatedAt,head,pending,pendingAt,pull,continues,idea,context,hold,recheck)
  SELECT id,repository,workflow,target,revision,branch,actor,trusted,pinRunner,pinAccount,state,attempt,runner,account,session,lease,delivered,cancel,summary,result,createdAt,updatedAt,head,pending,pendingAt,pull,continues,idea,context,hold,recheck FROM jobs;
CREATE TABLE kept_job_events AS SELECT * FROM job_events ORDER BY rowid;
CREATE TABLE kept_job_questions AS SELECT * FROM job_questions ORDER BY rowid;
CREATE TABLE kept_job_output_attempts AS SELECT * FROM job_output_attempts;
CREATE TABLE kept_job_output AS SELECT * FROM job_output;
DROP TABLE jobs;
ALTER TABLE jobs_rebuilt RENAME TO jobs;
DELETE FROM job_events;
DELETE FROM job_questions;
DELETE FROM job_output_attempts;
DELETE FROM job_output;
INSERT INTO job_events SELECT * FROM kept_job_events ORDER BY rowid;
INSERT INTO job_questions SELECT * FROM kept_job_questions ORDER BY rowid;
INSERT INTO job_output_attempts SELECT * FROM kept_job_output_attempts;
INSERT INTO job_output SELECT * FROM kept_job_output;
DROP TABLE kept_job_events;
DROP TABLE kept_job_questions;
DROP TABLE kept_job_output_attempts;
DROP TABLE kept_job_output;
CREATE UNIQUE INDEX jobs_active ON jobs(repository,target) WHERE state IN ('queued','running','waiting');
CREATE INDEX jobs_claimable ON jobs(actor,state,createdAt);
CREATE INDEX jobs_target ON jobs(repository, target, createdAt);
