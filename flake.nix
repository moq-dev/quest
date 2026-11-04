{
  description = "Quest - versioned plans for repository work";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # A reviewed quest for the dev shell's merge driver, so local merges resolve
    # link lists without running the checkout's own, possibly unreviewed, code.
    # Only its source is pinned, so the lock never chains older pins. Dependabot's
    # weekly nix update bumps it in its own PR, without the cooldown; bump it by
    # hand with `nix flake update quest-pinned`.
    quest-pinned = {
      url = "github:moq-dev/quest";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      quest-pinned,
      ...
    }:
    # The pinned nixpkgs no longer evaluates on x86_64-darwin; Intel Macs use the release binary.
    flake-utils.lib.eachSystem
      [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ]
      (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            # Claude Code is unfree; the runner package pins it so adapters run a tested version.
            config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "claude-code";
          };
          inherit (pkgs) opencode;
          sandboxRuntime = pkgs.callPackage ./nix/sandbox-runtime.nix { };
          quest = pkgs.callPackage ./nix/package.nix { };
          questPinned = pkgs.callPackage "${quest-pinned}/nix/package.nix" { };
          # https://downloads.claude.ai/claude-code-releases/2.1.305/manifest.zst.json
          # Keep the tested runner version independent of nixpkgs.
          claudeCode = pkgs.claude-code.override {
            manifest = pkgs.lib.importJSON ./nix/claude-code.json;
          };
          # `quest runner` with pinned agent CLIs, the sandbox-runtime that runs opencode
          # jobs' commands, and on Linux the bubblewrap and socat Claude Code's sandbox runs its jobs' commands in.
          runner = pkgs.symlinkJoin {
            name = "quest-runner-${quest.version}";
            paths = [ quest ];
            nativeBuildInputs = [ pkgs.makeWrapper ];
            postBuild = ''
              wrapProgram $out/bin/quest \
                --set-default QUEST_RUNNER_CLAUDE ${pkgs.lib.getExe claudeCode} \
                --set-default QUEST_RUNNER_OPENCODE ${pkgs.lib.getExe opencode} \
                --set-default QUEST_RUNNER_CODEX ${pkgs.lib.getExe pkgs.codex} \
                --set-default QUEST_RUNNER_SRT ${pkgs.lib.getExe sandboxRuntime} ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "--prefix PATH : ${
                  pkgs.lib.makeBinPath [
                    pkgs.bubblewrap
                    pkgs.socat
                  ]
                }"}
            '';
            meta = quest.meta;
          };
          manifest = pkgs.lib.importJSON ./package.json;
          # package.json's packageManager pins Bun for CI runners without Nix.
          bunVersion = pkgs.lib.removePrefix "bun@" manifest.packageManager;
          # The runner drives the pinned opencode through the client of the same release.
          opencodeClient = manifest.dependencies."@opencode/client";
        in
        {
          packages = {
            inherit quest runner;
            default = quest;
          };
          apps.default = flake-utils.lib.mkApp { drv = quest; };
          devShells.default = pkgs.mkShell {
            packages =
              with pkgs;
              [
                # Installs dependencies, runs every script and tool, and compiles the release binaries.
                bun
                # `quest resolve` for the merge driver; `just` and `bun run quest` run the checkout.
                questPinned
                just
                jq
                git
                gh
                direnv
                actionlint
                shellcheck
                shfmt
                nixfmt
                # GNU time, which the gate's cancellation tests put between Bash and their leaf.
                time
              ]
              # `flock` (the land daemon's repository lock) and `script` (the tests' terminal), which
              # self-hosted NixOS runners don't otherwise provide.
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.util-linux ];
            # The runner package's opencode and sandbox-runtime, for the sandbox boundary test
            # (test/live/runner-sandbox.test.ts), which runs where srt does. Named as the runner
            # finds them rather than put on PATH, where they would shadow the user's own opencode.
            env = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
              QUEST_RUNNER_OPENCODE = pkgs.lib.getExe opencode;
              QUEST_RUNNER_SRT = pkgs.lib.getExe sandboxRuntime;
            };
          };
          formatter = pkgs.nixfmt;
          checks = {
            package = quest;
            bun-version = pkgs.runCommand "bun-version" { } ''
              if [ "${pkgs.bun.version}" != "${bunVersion}" ]; then
                echo "package.json pins bun@${bunVersion}, but the flake provides Bun ${pkgs.bun.version}" >&2
                exit 1
              fi
              touch "$out"
            '';
            opencode-client = pkgs.runCommand "opencode-client" { } ''
              if [ "${opencode.version}" != "${opencodeClient}" ]; then
                echo "package.json pins @opencode/client ${opencodeClient}, but the runner pins opencode ${opencode.version}" >&2
                exit 1
              fi
              touch "$out"
            '';
            quest-tree = pkgs.runCommand "quest-tree" { nativeBuildInputs = [ quest ]; } ''
              quest --root ${self} check
              touch "$out"
            '';
          };
        }
      );
}
