// The version this build reports. A release binary embeds its tag and a flake build its commit, each
// through `bun build --define QUEST_VERSION=...`; a checkout run from source reports `dev`.
declare const QUEST_VERSION: string | undefined;

export const version: string = typeof QUEST_VERSION === "string" ? QUEST_VERSION : "dev";
