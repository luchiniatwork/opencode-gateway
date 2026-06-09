{
  description = "Development shell for opencode-gateway";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    opencode-darwin-arm64 = {
      url = "https://registry.npmjs.org/opencode-darwin-arm64/-/opencode-darwin-arm64-1.16.2.tgz";
      flake = false;
    };
    opencode-darwin-x64 = {
      url = "https://registry.npmjs.org/opencode-darwin-x64/-/opencode-darwin-x64-1.16.2.tgz";
      flake = false;
    };
    opencode-linux-arm64 = {
      url = "https://registry.npmjs.org/opencode-linux-arm64/-/opencode-linux-arm64-1.16.2.tgz";
      flake = false;
    };
    opencode-linux-x64 = {
      url = "https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.16.2.tgz";
      flake = false;
    };
  };

  outputs =
    { nixpkgs
    , opencode-darwin-arm64
    , opencode-darwin-x64
    , opencode-linux-arm64
    , opencode-linux-x64
    , ...
    }:
    let
      opencodeVersion = "1.16.2";
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;
      opencodeSources = {
        aarch64-darwin = opencode-darwin-arm64;
        aarch64-linux = opencode-linux-arm64;
        x86_64-darwin = opencode-darwin-x64;
        x86_64-linux = opencode-linux-x64;
      };
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          opencode = pkgs.stdenvNoCC.mkDerivation {
            pname = "opencode";
            version = opencodeVersion;
            src = opencodeSources.${system};

            dontBuild = true;

            installPhase = ''
              runHook preInstall

              install -Dm755 "$src/bin/opencode" "$out/bin/opencode"

              runHook postInstall
            '';
          };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              opencode
            ];

            shellHook = ''
              export BUN_INSTALL_CACHE_DIR="$PWD/.bun-cache"
              export PS1='\[\e[31m\](opencode-gateway) \w \$\[\e[0m\] '
              echo "bun $(bun --version)"
            '';
          };
        });
    };
}
