{
  description = "";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
	  inherit system;
	  config = {
	    allowUnfree = true;
	    problems.handlers = {
              docling-parse.broken = "warn"; # or "ignore"
            };
	  };
	};
        # PaddleOCR, for 4chan-post-ocr, from nixpkgs, in two builds:
        # CPU for the default shell (~3.4GiB, in cache.nixos.org) and CUDA
        # for `nix develop .#cuda` (~11.5GiB, nearly all of it CUDA). A flake
        # cannot detect a GPU -- evaluation is pure -- so the developer picks.
        # The CPU build is ~30x slower on the benchmark (13min against 27s)
        # but reads the same.
        #
        # Only paddlepaddle gets CUDA. config.cudaSupport would turn it on
        # for every package that has it -- opencv among them -- and
        # cache.nixos.org builds none of those, so each would compile from
        # source. paddlepaddle itself is NVIDIA's prebuilt wheel, patched to
        # load nixpkgs' cudatoolkit and cuDNN.
        paddlePython3For = cuda: pkgs.python313.override {
          packageOverrides = self: super: {
            paddlepaddle =
              if !cuda then super.paddlepaddle
              else (super.paddlepaddle.override { cudaSupport = true; }).overridePythonAttrs
                (old: {
                  # The GPU wheel's metadata still names the pip CUDA
                  # packages, which the derivation replaces with
                  # cudaPackages on the rpath -- so nixpkgs' runtime
                  # dependency check fails the build. Nixpkgs builds no CUDA
                  # packages for its cache, which is how this goes unnoticed.
                  pythonRemoveDeps = (old.pythonRemoveDeps or [ ]) ++ [
                    "nvidia-cuda-nvrtc-cu12"
                    "nvidia-cuda-runtime-cu12"
                    "nvidia-cuda-cupti-cu12"
                    "nvidia-cudnn-cu12"
                    "nvidia-cublas-cu12"
                    "nvidia-cufft-cu12"
                    "nvidia-curand-cu12"
                    "nvidia-cusolver-cu12"
                    "nvidia-cusparse-cu12"
                    "nvidia-cusparselt-cu12"
                    "nvidia-nccl-cu12"
                    "nvidia-nvtx-cu12"
                    "nvidia-nvjitlink-cu12"
                    "nvidia-cufile-cu12"
                    "cuda-python"
                    "nvidia-cuda-cccl-cu12"
                  ];
                });
            # nixpkgs' paddleocr does not install PaddleX's `ocr-core` extra,
            # without which the OCR pipeline refuses to start. Its OpenCV is
            # also checked for by pip's distribution name,
            # `opencv-contrib-python`, which nixpkgs' OpenCV does not carry --
            # so that check is pointed at the `cv2` module it provides.
            paddlex = super.paddlex.overridePythonAttrs (old: {
              dependencies = (old.dependencies or [ ]) ++ [
                self.imagesize
                self.opencv4
                self.pypdfium2
                self.python-bidi
              ];
              postPatch = (old.postPatch or "") + ''
                substituteInPlace paddlex/utils/deps.py \
                  --replace-fail '    elif dep == "onnxruntime":' '    elif dep.startswith("opencv"):
                        return importlib.util.find_spec("cv2") is not None
                    elif dep == "onnxruntime":'
              '';
            });
          };
        };
        paddlePythonFor = cuda: let
          env = (paddlePython3For cuda).withPackages (ps: [
            ps.paddleocr
            ps.paddlepaddle
            ps.numpy
            ps.pillow
          ]);
        in pkgs.writeShellScriptBin "paddle-python" ''
          dir=$PWD
          while [ ! -d "$dir/sources" ]; do
            if [ "$dir" = / ]; then
              echo "paddle-python: not inside the repo" >&2
              exit 1
            fi
            dir=$(dirname "$dir")
          done
          ${pkgs.lib.optionalString cuda ''
          # The GPU driver is the one thing Nix cannot supply: libcuda has to
          # match the host's kernel module, and nixpkgs looks for it in
          # /run/opengl-driver/lib, which only NixOS has. Only the driver's
          # own libraries are linked in -- all of /usr/lib64 would put the
          # distro's other libraries ahead of Nix's. Re-linked every run, so a
          # driver update is picked up; overwritten in place rather than
          # deleted first, because parallel runs share the directory. No
          # driver, no links, and paddle uses the CPU.
          driver="$dir/.cache/nvidia-driver"
          mkdir -p "$driver"
          for d in /run/opengl-driver/lib /usr/lib64 /usr/lib/x86_64-linux-gnu; do
            if [ -e "$d/libcuda.so.1" ]; then
              ln -sf "$d"/libcuda.so* "$d"/libnvidia-*.so* "$driver"/ 2>/dev/null
              break
            fi
          done
          export LD_LIBRARY_PATH="$driver''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
          ''}
          # Downloaded models, kept with the checkout's other caches
          # rather than in ~/.paddlex.
          export PADDLE_PDX_CACHE_HOME="$dir/.cache/paddlex"
          exec ${env}/bin/python "$@"
        '';

        mkDevShell = paddlePython: pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_26
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
            # 4chan-post-ocr reads post headers out of screenshots with
            # PaddleOCR, CPU or CUDA; see paddlePythonFor above
            paddlePython

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
            source .env
          '';
        };
      in
      {
        devShells.default = mkDevShell (paddlePythonFor false);
        devShells.cuda = mkDevShell (paddlePythonFor true);
      }
    );
}
