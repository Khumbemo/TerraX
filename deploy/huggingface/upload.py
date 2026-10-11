"""Uploads TerraX to a Hugging Face Space (Docker SDK).

    HF_TOKEN=hf_... python deploy/huggingface/upload.py <user>/<space>

Only files tracked by git are sent, with deploy/huggingface/README.md as the
Space's README (its front matter tells Hugging Face to build the root
Dockerfile). The Hub API stores the map images and samples as large files
itself, so no git LFS setup is needed. The Space is created if it is missing.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPACE_README = Path(__file__).with_name("README.md")
# Not needed to build or run the container.
SKIP = (".github/", "frontend/tests/", "backend/tests/", "render.yaml", "deploy/")


def tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True).stdout.decode()
    return [f for f in out.split("\0") if f and not f.startswith(SKIP) and f != "README.md"]


def stage(dest: Path) -> int:
    files = tracked_files()
    for f in files:
        target = dest / f
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / f, target)
    shutil.copy2(SPACE_README, dest / "README.md")
    return len(files) + 1


def main() -> None:
    if len(sys.argv) != 2 or "/" not in sys.argv[1]:
        sys.exit("Usage: HF_TOKEN=... python deploy/huggingface/upload.py <user>/<space>")
    token = os.environ.get("HF_TOKEN")
    if not token:
        sys.exit("Set HF_TOKEN to a Hugging Face access token with write permission.")
    from huggingface_hub import HfApi

    space = sys.argv[1]
    api = HfApi(token=token)
    api.create_repo(space, repo_type="space", space_sdk="docker", exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        n = stage(Path(tmp))
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        api.upload_folder(folder_path=tmp, repo_id=space, repo_type="space", delete_patterns=["*"], commit_message=f"TerraX {sha or 'update'} from GitHub")
    print(f"Uploaded {n} files to https://huggingface.co/spaces/{space}")


if __name__ == "__main__":
    main()
