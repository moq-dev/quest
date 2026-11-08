-- A maintainer's opt-in to start a project's ready quests on their own
-- runners whenever one of their job slots frees, within the listed milestone
-- directories (a JSON array), or every milestone when NULL. It lasts only as
-- long as the membership: a lost maintainer role, a disconnect, or a deleted
-- account ends it, so regaining access never resumes starts unasked.
CREATE TABLE autostart (
  repository INTEGER NOT NULL,
  user TEXT NOT NULL,
  milestones TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(repository, user),
  FOREIGN KEY(repository, user) REFERENCES github_project_members(repository, user) ON DELETE CASCADE
);
CREATE INDEX autostart_user ON autostart(user);
