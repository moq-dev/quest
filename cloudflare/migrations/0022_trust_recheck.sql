-- Whether a PR job's recorded trust is stale: set when the job enters the
-- queue or its head moves, such as after an answer to a job kix pushed for, or
-- a lease expiry. Dispatch rereads a queued job's stale trust even without a
-- free runner slot, so the inbox shows the head approval at once. New jobs
-- start stale, and existing ones are rechecked once.
ALTER TABLE jobs ADD COLUMN recheck INTEGER NOT NULL DEFAULT 1 CHECK(recheck IN (0,1));
