-- A maintainer's opt-in to start a project's ready quests on their own
-- runners whenever one of their job slots frees, within the listed milestone
-- directories (a JSON array), or every milestone when NULL.
CREATE TABLE autostart (
  repository INTEGER NOT NULL REFERENCES github_projects(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  milestones TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(repository, user)
);
CREATE INDEX autostart_user ON autostart(user);
