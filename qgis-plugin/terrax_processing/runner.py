"""Runs the ``terrax`` command for an algorithm: inputs as files, progress and cancellation through QGIS feedback.

TerraX runs in its own Python environment (it needs a newer GDAL stack than some QGIS builds ship), so the plugin
never imports it: it starts the command, which writes result.json, report.md and the output files to a folder.
"""

from __future__ import annotations

import contextlib
import json
import os
import shlex
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from qgis.core import (
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsCoordinateTransformContext,
    QgsProcessingException,
    QgsVectorFileWriter,
    QgsVectorLayer,
)

SETTING = "TERRAX_COMMAND"


def command() -> list[str]:
    """The terrax command: the provider setting (a path, or a command line such as `/opt/venv/bin/python -m terrax`), else
    `terrax` on PATH."""
    from processing.core.ProcessingConfig import ProcessingConfig

    configured = (ProcessingConfig.getSetting(SETTING) or "").strip()
    if configured:
        return shlex.split(configured)
    found = shutil.which("terrax")
    if found:
        return [found]
    raise QgsProcessingException(
        "The terrax command was not found. Install TerraX (pip install -e backend from the TerraX repository, in a Python 3.11+ environment), "
        "then set its path under Settings → Options → Processing → Providers → TerraX.")


def vector_to_geojson(layer: QgsVectorLayer, folder: str, name: str, context) -> str:
    """A vector layer as a WGS84 GeoJSON file (TerraX reads GeoJSON in longitude/latitude, as RFC 7946 defines)."""
    path = os.path.join(folder, f"{name}.geojson")
    tc = context.transformContext() if context is not None else QgsCoordinateTransformContext()
    opts = QgsVectorFileWriter.SaveVectorOptions()
    opts.driverName = "GeoJSON"
    opts.fileEncoding = "UTF-8"
    opts.ct = QgsCoordinateTransform(layer.crs(), QgsCoordinateReferenceSystem("EPSG:4326"), tc)
    err, msg, *_ = QgsVectorFileWriter.writeAsVectorFormatV3(layer, path, tc, opts)
    if err != QgsVectorFileWriter.NoError:
        raise QgsProcessingException(f"Could not write {layer.name()} as GeoJSON: {msg}")
    return path


def raster_path(layer, what: str) -> str:
    """The file behind a raster layer (TerraX reads GeoTIFF and other GDAL files, not web services)."""
    src = layer.source().split("|")[0]
    if not os.path.isfile(src):
        raise QgsProcessingException(f"{what} ({layer.name()}) is not a file on disk; save it as a GeoTIFF first.")
    return src


def run(tool: str, inputs: dict, params: dict, out: str, feedback, boundary: str | None = None) -> dict:
    """Runs one tool; returns its result.json. Raises QgsProcessingException with TerraX's message on failure."""
    os.makedirs(out, exist_ok=True)
    args = [*command(), "run", tool, "-o", out, "--progress"]
    for slot, value in inputs.items():
        if value in (None, "", []):
            continue
        args += ["-i", f"{slot}={','.join(value) if isinstance(value, list | tuple) else value}"]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as pf:
        json.dump(params, pf)
    args += ["--params", pf.name]
    if boundary:
        args += ["--boundary", boundary]
    feedback.pushCommandInfo(" ".join(shlex.quote(a) for a in args))
    errors: list[str] = []
    try:
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    except OSError as e:
        raise QgsProcessingException(f"Could not start {args[0]}: {e}") from None

    def watch() -> None:  # stop the command when the user cancels
        while proc.poll() is None:
            if feedback.isCanceled():
                proc.kill()
                return
            threading.Event().wait(0.2)

    threading.Thread(target=watch, daemon=True).start()
    assert proc.stderr is not None
    with proc.stderr:
        _read(proc.stderr, feedback, errors)
    code = proc.wait()
    Path(pf.name).unlink(missing_ok=True)
    if feedback.isCanceled():
        raise QgsProcessingException("Cancelled.")
    if code != 0:
        msg = next((e.removeprefix("terrax: ") for e in reversed(errors) if e.startswith("terrax: ")), errors[-1] if errors else f"terrax exited with {code}")
        raise QgsProcessingException(msg)
    return json.loads(Path(out, "result.json").read_text(encoding="utf-8"))


def _read(stream, feedback, errors: list[str]) -> None:
    """Progress lines move the progress bar; anything else is logged (and kept for the error message)."""
    for line in stream:
        line = line.rstrip()
        if line.startswith("PROGRESS "):
            _, frac, *msg = line.split(" ", 2)
            with contextlib.suppress(ValueError):
                feedback.setProgress(100 * float(frac))
            if msg:
                feedback.setProgressText(msg[0])
        elif line:
            errors.append(line)
            feedback.pushInfo(line)
