{
  description = "Development shell for opencode-gateway";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
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
