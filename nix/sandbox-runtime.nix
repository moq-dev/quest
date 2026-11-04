# nixpkgs' sandbox-runtime (`srt`) with its seccomp helper, which nixpkgs leaves out. Without it
# srt runs commands with Unix sockets open, the Nix daemon's included. (User namespaces stay
# refused either way: with no helper, srt passes the bwrap 0.8+ on its PATH `--disable-userns`.)
# The helper is built from srt's own source by its own build script.
{
  lib,
  stdenv,
  sandbox-runtime,
  bun,
  glibc,
  libseccomp,
}:
let
  # srt looks for the helper under its Node architecture's name.
  arch =
    {
      x86_64 = "x64";
      aarch64 = "arm64";
    }
    .${stdenv.hostPlatform.parsed.cpu.name};
  applySeccomp = stdenv.mkDerivation {
    pname = "sandbox-runtime-apply-seccomp";
    inherit (sandbox-runtime) version src;
    nativeBuildInputs = [ bun ];
    # The build links its filter generator and the helper statically, as srt's releases do.
    buildInputs = [
      glibc.static
      (libseccomp.overrideAttrs {
        dontDisableStatic = true;
        doCheck = false;
      })
    ];
    buildPhase = ''
      runHook preBuild
      bun vendor/seccomp/build.ts
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      install -Dm755 vendor/seccomp/${arch}/apply-seccomp $out/bin/apply-seccomp
      runHook postInstall
    '';
    meta = sandbox-runtime.meta // {
      mainProgram = "apply-seccomp";
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  };
in
if !stdenv.hostPlatform.isLinux then
  sandbox-runtime
else
  sandbox-runtime.overrideAttrs (old: {
    # Where srt finds it: vendor/seccomp/<arch>/ in its package root.
    postInstall = (old.postInstall or "") + ''
      install -Dm755 ${lib.getExe applySeccomp} \
        $out/lib/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/${arch}/apply-seccomp
    '';
  })
