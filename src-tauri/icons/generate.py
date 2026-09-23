"""Rasterize the Sabiá bird artwork into the app's icon set.

The previous generator (generate.mjs) was dependency-free by necessity: the
icon was a geometric aircraft mark drawn with arithmetic directly onto a pixel
buffer, and a hand-rolled PNG/ICO writer over node:zlib was the cheapest way
to get that mark into the required files without installing anything.

That mark is retired. The icon is now supplied artwork - a bezier-path bird
drawn in an external tool (svg/sabianotext.svg) - and there is no reasonable
case for hand-writing an SVG rasterizer to draw those curves ourselves when
two tools already on this machine do the job correctly: Microsoft Edge
(headless) renders the SVG with the same engine the app's own WebView2 uses,
and Pillow (already installed, see src-tauri/tools/check-core.py for other
Python tooling in this repo) resizes it cleanly and writes a multi-size ICO
directly. Using them is simpler and more faithful than arithmetic ever was.

Run with: python src-tauri/icons/generate.py
Requires: msedge.exe on this machine, and Pillow (pip install pillow).
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

DIRECTORY = Path(__file__).resolve().parent
REPO_ROOT = DIRECTORY.parent.parent
SVG_SOURCE = REPO_ROOT / "svg" / "sabianotext.svg"
EDGE = Path(
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)

# Render once at a large size and downsample - Edge's headless screenshot
# silently produces a blank image below its minimum window size, so never
# ask it for a small render directly.
RENDER_SIZE = 512

OUTPUT_SIZES = [
    ("32x32.png", 32),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
    ("icon.png", 256),
]

ICO_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def rasterise_svg(scratch_dir: Path) -> Path:
    if not EDGE.exists():
        sys.exit(f"msedge.exe not found at {EDGE}")
    if not SVG_SOURCE.exists():
        sys.exit(f"SVG source not found at {SVG_SOURCE}")

    profile_dir = scratch_dir / "edge-profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    render_path = scratch_dir / "bird512.png"

    subprocess.run(
        [
            str(EDGE),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--default-background-color=00000000",
            f"--user-data-dir={profile_dir}",
            f"--window-size={RENDER_SIZE},{RENDER_SIZE}",
            f"--screenshot={render_path}",
            SVG_SOURCE.resolve().as_uri(),
        ],
        check=True,
    )
    if not render_path.exists():
        sys.exit("Edge did not produce a render (blank/missing screenshot).")
    return render_path


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="sabia-icons-") as scratch:
        scratch_dir = Path(scratch)
        render_path = rasterise_svg(scratch_dir)
        source = Image.open(render_path).convert("RGBA")
        if source.size != (RENDER_SIZE, RENDER_SIZE):
            sys.exit(f"Unexpected render size: {source.size}")

        for name, size in OUTPUT_SIZES:
            resized = source.resize((size, size), Image.LANCZOS)
            resized.save(DIRECTORY / name)

        ico_source = source.resize((256, 256), Image.LANCZOS)
        ico_source.save(DIRECTORY / "icon.ico", sizes=ICO_SIZES)

    print(
        "Generated 32x32.png, 128x128.png, 128x128@2x.png, icon.png "
        "and a six-size ICO from svg/sabianotext.svg."
    )


if __name__ == "__main__":
    main()
