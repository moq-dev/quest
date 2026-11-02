{
  description = "Quest - versioned plans for repository work";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # Temporary: opencode 1.19.0, matching the @opencode-ai/sdk pin, from the
    # nixpkgs before opencode 2. /quest/m0/opencode-sdk.md migrates the runner
    # to opencode 2 and removes this input.
    nixpkgs-opencode.url = "github:NixOS/nixpkgs/f20cd90e28fe0403873f473b29e42662cd86e8c4";
    flake-utils.url = "github:numtide/flake-utils";
    # A reviewed quest for the dev shell's merge driver, so local merges resolve
    # link lists without running the checkout's own, possibly unreviewed, code.
    # Only its source is pinned, so the lock never chains older pins. Bump with
    # `nix flake update quest-pinned`.
    quest-pinned = {
      url = "github:moq-dev/quest";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-opencode,
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
          opencode = nixpkgs-opencode.legacyPackages.${system}.opencode;
          quest = pkgs.callPackage ./nix/package.nix { };
          questPinned = pkgs.callPackage "${quest-pinned}/nix/package.nix" { };
          # https://downloads.claude.ai/claude-code-releases/2.1.305/manifest.zst.json
          # Keep the tested runner version independent of nixpkgs.
          claudeCode = pkgs.claude-code.override {
            manifest = pkgs.lib.importJSON ./nix/claude-code.json;
          };
          # `quest runner` with pinned agent CLIs, and on
          # Linux the bubblewrap and socat Claude Code's sandbox runs its jobs' commands in.
          runner = pkgs.symlinkJoin {
            name = "quest-runner-${quest.version}";
            paths = [ quest ];
            nativeBuildInputs = [ pkgs.makeWrapper ];
            postBuild = ''
              wrapProgram $out/bin/quest \
                --set-default QUEST_RUNNER_CLAUDE ${pkgs.lib.getExe claudeCode} \
                --set-default QUEST_RUNNER_OPENCODE ${pkgs.lib.getExe opencode} ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "--prefix PATH : ${
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
          # The runner drives the pinned opencode through the SDK of the same release.
          opencodeSdk = manifest.dependencies."@opencode-ai/sdk";
        in
        {
          packages = {
            inherit quest runner;
            default = quest;
          };
          apps.default = flake-utils.lib.mkApp { drv = quest; };
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
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
            ];
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
            opencode-sdk = pkgs.runCommand "opencode-sdk" { } ''
              if [ "${opencode.version}" != "${opencodeSdk}" ]; then
                echo "package.json pins @opencode-ai/sdk ${opencodeSdk}, but the runner pins opencode ${opencode.version}" >&2
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
