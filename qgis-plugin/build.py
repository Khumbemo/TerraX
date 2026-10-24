"""Packages the plugin as dist/terrax_processing.zip, for QGIS's Plugins → Manage and Install Plugins → Install from ZIP."""

import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "terrax_processing"


def build() -> Path:
    out = HERE / "dist" / "terrax_processing.zip"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(SRC.rglob("*")):
            if f.is_file() and "__pycache__" not in f.parts:
                z.write(f, f.relative_to(HERE).as_posix())
    return out


if __name__ == "__main__":
    print(build())
