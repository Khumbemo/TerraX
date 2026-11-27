"""Uploads TerraX to a Hugging Face Space (Docker SDK).

    HF_TOKEN=hf_... python deploy/huggingface/upload.py [<user>/<space>]

Without a <user>/<space> argument (or with one that is not of that form) the Space
is <token owner>/terrax.

Only files tracked by git are sent, with deploy/huggingface/README.md as the
Space's README (its front matter tells Hugging Face to build the root
Dockerfile). The Hub API stores the map images and samples as large files
itself, so no git LFS setup is needed. The Space is created if it is missing.
"""

from __future__ import annotations

import os
import re
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


def space_name(arg: str | None, owner: str) -> tuple[str, str | None]:
    """The Space to upload to, and a note when the argument was not usable."""
    arg = (arg or "").strip()
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", arg):
        return arg, None
    note = f"HF_SPACE {'is not of the form <user>/<space>' if arg else 'is not set'}; using {owner}/terrax."
    return f"{owner}/terrax", note


def main() -> None:
    if len(sys.argv) > 2:
        sys.exit("Usage: HF_TOKEN=... python deploy/huggingface/upload.py [<user>/<space>]")
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        sys.exit("Set HF_TOKEN to a Hugging Face access token with write permission.")
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    owner = api.whoami()["name"]
    space, note = space_name(sys.argv[1] if len(sys.argv) == 2 else None, owner)
    if note:
        print(note)
    api.create_repo(space, repo_type="space", space_sdk="docker", exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        n = stage(Path(tmp))
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        api.upload_folder(folder_path=tmp, repo_id=space, repo_type="space", delete_patterns=["*"], commit_message=f"TerraX {sha or 'update'} from GitHub")
    print(f"Uploaded {n} files to https://huggingface.co/spaces/{space}")


if __name__ == "__main__":
    main()
