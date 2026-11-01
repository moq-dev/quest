# The `quest` CLI built from source: the same Bun bundle `bun run build` makes.
{
  lib,
  stdenvNoCC,
  bun,
  fetchurl,
}:
let
  manifest = lib.importJSON ../package.json;
  # bun.lock is JSON with trailing commas.
  lock = builtins.fromJSON (
    lib.concatMapStrings (part: if lib.isList part then lib.head part else part) (
      builtins.split ",([[:space:]]*[]}])" (builtins.readFile ../bun.lock)
    )
  );
  packages = lock.packages;

  # A lock key is the chain of package names from the root, so `a/@s/b` is
  # `@s/b` nested under `a`.
  segments =
    key:
    lib.foldl' (
      acc: part:
      if acc != [ ] && builtins.match "@[^/]*" (lib.last acc) != null then
        lib.init acc ++ [ "${lib.last acc}/${part}" ]
      else
        acc ++ [ part ]
    ) [ ] (lib.splitString "/" key);

  # The lockfile also covers the Worker and the test tooling, which the CLI
  # bundle never touches. Keep only the entries its runtime dependencies reach,
  # resolved the way Bun does: the nearest enclosing package wins.
  resolve =
    from: name:
    let
      scopes = if from == "" then [ ] else segments from;
    in
    lib.findFirst (key: packages ? ${key}) null (
      lib.genList (i: lib.concatStringsSep "/" (lib.take (lib.length scopes - i) scopes ++ [ name ])) (
        lib.length scopes + 1
      )
    );
  reach = from: deps: lib.filter (key: key != null) (map (resolve from) (lib.attrNames deps));
  closure = builtins.genericClosure {
    startSet = map (key: { inherit key; }) (reach "" manifest.dependencies);
    operator =
      { key }:
      let
        meta = lib.elemAt packages.${key} 2;
      in
      map (key: { inherit key; }) (
        reach key (
          meta.dependencies or { } // meta.optionalDependencies or { } // meta.peerDependencies or { }
        )
      );
  };

  # Each entry is [ "name@version" registry metadata integrity ].
  tarball =
    key:
    let
      entry = packages.${key};
      name = lib.last (segments key);
      version = lib.removePrefix "${name}@" (lib.head entry);
    in
    fetchurl {
      url = "https://registry.npmjs.org/${name}/-/${baseNameOf name}-${version}.tgz";
      hash = lib.elemAt entry 3;
    };
  unpack =
    { key }:
    let
      dir = lib.concatMapStringsSep "/" (name: "node_modules/${name}") (segments key);
    in
    ''
      mkdir -p ${dir}
      tar -xzf ${tarball key} --strip-components=1 -C ${dir}
    '';
in
stdenvNoCC.mkDerivation {
  pname = manifest.name;
  inherit (manifest) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bunfig.toml
      ../tsconfig.json
      ../src
      ../scripts/executable.mjs
      ../assets
    ];
  };

  nativeBuildInputs = [ bun ];
  # The bundle's `#!/usr/bin/env bun` is patched to this Bun.
  buildInputs = [ bun ];

  configurePhase = ''
    runHook preConfigure
    ${lib.concatMapStrings unpack closure}
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    bun run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dist/quest.js $out/bin/quest
    runHook postInstall
  '';

  meta = {
    inherit (manifest) description;
    homepage = "https://github.com/moq-dev/quest";
    license = with lib.licenses; [
      mit
      asl20
    ];
    mainProgram = "quest";
  };
}
