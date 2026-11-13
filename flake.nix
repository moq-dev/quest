{
  description = "Quest - versioned plans for repository work";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # Bun 1.4.4, ahead of `nixpkgs`: 1.4.2 passes its non-blocking stderr to the
    # commands it spawns, which uv aborts on (oven-sh/bun#43868). Drop this input
    # once `nixpkgs` reaches 1.4.4.
    nixpkgs-bun.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
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
    # token-max, which reads and prices `quest usage`'s sessions; the lock pins it so its JSON stays what the
    # parser reads. Its own quest input follows this flake, so the lock never chains older quest pins.
    token-max = {
      url = "github:kixel-ai/token-max";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
      inputs.quest.follows = "";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-bun,
      flake-utils,
      quest-pinned,
      token-max,
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
            overlays = [ (_: _: { inherit (nixpkgs-bun.legacyPackages.${system}) bun; }) ];
          };
          quest = pkgs.callPackage ./nix/package.nix { };
          questPinned = pkgs.callPackage "${quest-pinned}/nix/package.nix" { };
          manifest = pkgs.lib.importJSON ./package.json;
          # package.json's packageManager pins Bun for CI runners without Nix.
          bunVersion = pkgs.lib.removePrefix "bun@" manifest.packageManager;
        in
        {
          packages = {
            inherit quest;
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
                # Exports and prices `quest usage`'s sessions.
                token-max.packages.${system}.default
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
            quest-tree = pkgs.runCommand "quest-tree" { nativeBuildInputs = [ quest ]; } ''
              quest --root ${self} check
              touch "$out"
            '';
          };
        }
      );
}
