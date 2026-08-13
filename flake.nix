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
            # mount stuff on storage server
            sshfs
            # for poking at the post database by hand
            sqlite
            postgresql
            # rasterizes the analysis charts (SVG -> PNG) without pulling a
            # native npm dependency into the build
            resvg
            # resvg resolves font families through fontconfig; pinning the
            # font here keeps chart text identical on any machine
            dejavu_fonts
            fontconfig

            R
            rstudio
            rstudio-server
          ];

          # >&2 deliberately: this banner runs for `nix develop --command`
          # too, so on stdout it prepends two lines to whatever the command
          # printed. That is invisible for a table and fatal for
          # `search --json | jq`, which is exactly the case the redirect
          # protects.
          shellHook = ''
            echo "Node.js $(node --version)" >&2
            echo "npm $(npm --version)" >&2
          '';
        };
      }
    );
}
