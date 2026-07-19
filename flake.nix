{
  description = "";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_24
            # for staging/extracting the raw archives
            p7zip
            zstd
            # for poking at the post database by hand
            sqlite
          ];

          shellHook = ''
            echo "Node.js $(node --version)"
            echo "npm $(npm --version)"
          '';
        };
      }
    );
}
