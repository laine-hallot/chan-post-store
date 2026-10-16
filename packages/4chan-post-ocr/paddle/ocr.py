"""PaddleOCR over a list of screenshots, as JSON lines on stdout.

Run through the flake's `paddle-python` wrapper, nixpkgs' PaddleOCR with the
host's GPU driver linked in and the model cache pointed at .cache/.

    paddle-python packages/4chan-post-ocr/paddle/ocr.py IMAGE...

One line of output per image, in argument order:

    {"image": "<path>", "lines": [{"text": ..., "score": 0.97,
                                   "box": [left, top, width, height]}, ...]}

Boxes are in the original image's pixels. Paddle's own progress and warnings
go to stderr, so stdout carries nothing but the results.
"""

import json
import sys

import numpy as np
from PIL import Image


def load(path: str) -> np.ndarray:
    # PIL rather than letting Paddle open the file: cv2, which Paddle uses,
    # cannot read GIFs, and a few screenshots are GIFs. The first frame is
    # what a non-animating GIF shows. Paddle expects BGR, as cv2 gives it.
    with Image.open(path) as im:
        im.seek(0)
        rgb = np.asarray(im.convert("RGB"))
    return rgb[:, :, ::-1].copy()


def main() -> None:
    # Imported after argument checks would be nicer, but the import is where
    # the time goes either way: the models load once for every image.
    import paddle
    from paddleocr import PaddleOCR

    cpu_only = not paddle.device.is_compiled_with_cuda()
    ocr = PaddleOCR(
        # Paddle's CPU acceleration (oneDNN) crashes on these models in
        # 3.3.1 and 3.4.0 alike -- "ConvertPirAttribute2RuntimeAttribute not
        # support [pir::ArrayAttribute<pir::DoubleAttribute>]" -- so a
        # CPU-only build runs without it. Irrelevant on the GPU.
        enable_mkldnn=not cpu_only,
        # Screenshots are upright, flat, and never photographed: the
        # document-unwarping and orientation stages only cost time and can
        # only make things worse.
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )
    for path in sys.argv[1:]:
        lines = []
        for page in ocr.predict(load(path)):
            for text, score, box in zip(
                page["rec_texts"], page["rec_scores"], page["rec_boxes"]
            ):
                x0, y0, x1, y1 = (int(v) for v in box)
                lines.append(
                    {
                        "text": text,
                        "score": float(score),
                        "box": [x0, y0, x1 - x0, y1 - y0],
                    }
                )
        print(json.dumps({"image": path, "lines": lines}), flush=True)


if __name__ == "__main__":
    main()
