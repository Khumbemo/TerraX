"""What a running tool can use: inputs, progress reporting and result artifacts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from .. import storage
from ..processing.render import save_png


class ToolError(ValueError):
    """A problem with the user's data or settings, shown to them as is."""


class ToolContext:
    def __init__(self, job_id: str):
        self.job_id = job_id
        self.dir = storage.job_dir(job_id) / "artifacts"
        self.dir.mkdir(parents=True, exist_ok=True)

    # Inputs
    def file(self, file_id: str | None) -> storage.StoredFile | None:
        if not file_id:
            return None
        try:
            return storage.get_file(file_id)
        except KeyError:
            raise ToolError("An input file is no longer on the server (uploads are kept for a limited time). Upload it again.") from None

    def path(self, file_id: str) -> Path:
        f = self.file(file_id)
        assert f is not None
        return f.path

    # Progress
    def progress(self, fraction: float, message: str) -> None:
        storage.update_job(self.job_id, progress=round(max(0.0, min(1.0, fraction)), 3), message=message)

    # Artifacts
    def url(self, name: str) -> str:
        return f"/api/jobs/{self.job_id}/artifacts/{storage.safe_name(name)}"

    def png(self, name: str, rgba: np.ndarray) -> str:
        save_png(rgba, self.dir / storage.safe_name(name))
        return self.url(name)

    def json(self, name: str, data: Any) -> str:
        (self.dir / storage.safe_name(name)).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return self.url(name)

    def text(self, name: str, text: str) -> str:
        (self.dir / storage.safe_name(name)).write_text(text, encoding="utf-8")
        return self.url(name)

    def download(self, label: str, name: str, url: str, media: str) -> dict:
        return {"label": label, "filename": storage.safe_name(name), "url": url, "mediaType": media}
