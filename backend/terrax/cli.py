"""The ``terrax`` command: TerraX's tools on local files, without the web server.

    terrax tools                                   the tools, their inputs and main parameters
    terrax run forest -i a=ndvi_2016.tif -i b=ndvi_2024.tif -p mode=ndvi -o forest_result
    terrax run stack -i files=s2_2019.tif,s2_2020.tif,… -p mapBreaks=true -o series
    terrax run canopy -i chm=chm.tif -i plots=plots.geojson -p threshold=2 --boundary site.geojson -o canopy

Inputs are ``slot=path`` (comma-separated paths for slots that take several files). Parameters are ``key=value``;
values are read as JSON when they parse (numbers, true/false, lists, objects), else as text, and dotted keys build
nested objects (``-p view.mode=index``). ``--params file.json`` reads them from a file. The output folder gets
result.json, report.md and every output file (GeoTIFF, GeoJSON, CSV, PNG). ``--json`` prints the result to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .local import TOOLS, WEB_ONLY, TerraxError, boundary_from_file, run


def _value(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _params(pairs: list[str], file: str | None) -> dict[str, Any]:
    out: dict[str, Any] = json.loads(Path(file).read_text(encoding="utf-8")) if file else {}
    for pair in pairs:
        key, sep, val = pair.partition("=")
        if not sep or not key:
            raise SystemExit(f"Parameters are key=value; got “{pair}”.")
        node = out
        *parents, leaf = key.split(".")
        for k in parents:
            node = node.setdefault(k, {})
            if not isinstance(node, dict):
                raise SystemExit(f"“{k}” in “{key}” is already a value, not an object.")
        node[leaf] = _value(val)
    return out


def _inputs(pairs: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for pair in pairs:
        slot, sep, val = pair.partition("=")
        if not sep or not slot or not val:
            raise SystemExit(f"Inputs are slot=path; got “{pair}”.")
        paths = [v for v in val.split(",") if v]
        out[slot] = paths if len(paths) > 1 or slot == "files" else paths[0]
    return out


def _print_tools() -> None:
    for name, t in TOOLS.items():
        print(f"{name}\n  {t['summary']}")
        for slot, what in t["inputs"].items():
            print(f"    -i {slot}=…   {what}")
        for key, what in t["params"].items():
            print(f"    -p {key}=…   {what}")
    print(f"\nWeb app only: {', '.join(WEB_ONLY)}. Every raster tool also takes --boundary (polygons that limit the analysis).")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="terrax", description="TerraX earth-observation tools on local files.")
    ap.add_argument("--version", action="version", version=f"terrax {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("tools", help="list the tools, their inputs and main parameters")
    r = sub.add_parser("run", help="run one tool")
    r.add_argument("tool", help="tool name (see `terrax tools`)")
    r.add_argument("-i", "--input", action="append", default=[], metavar="SLOT=PATH", help="an input file (repeat for each slot)")
    r.add_argument("-p", "--param", action="append", default=[], metavar="KEY=VALUE", help="a parameter (JSON value or text)")
    r.add_argument("--params", metavar="FILE", help="parameters from a JSON file (-p values override them)")
    r.add_argument("--boundary", metavar="FILE", help="polygons (GeoJSON, KML, zipped shapefile) that limit the analysis")
    r.add_argument("-o", "--out", metavar="DIR", help="folder for result.json, report.md and the output files")
    r.add_argument("--json", action="store_true", help="print the result as JSON")
    r.add_argument("--progress", action="store_true", help="report progress on stderr as lines “PROGRESS <0–1> <message>” (for programs that run this)")
    a = ap.parse_args(argv)
    if a.cmd == "tools":
        _print_tools()
        return 0
    params = _params(a.param, a.params)
    try:
        if a.boundary:
            params["boundary"] = boundary_from_file(a.boundary)
        report = (lambda f, m: print(f"PROGRESS {f:.3f} {m}", file=sys.stderr, flush=True)) if a.progress else None
        res = run(a.tool, _inputs(a.input), params, out=a.out, progress=report)
    except (TerraxError, FileNotFoundError, ValueError) as e:
        print(f"terrax: {e}", file=sys.stderr)
        return 1
    if a.json:
        print(json.dumps(res.result, ensure_ascii=False, indent=2))
    else:
        print(res.markdown)
        if res.out:
            print(f"\nWrote {len(res.files) + 2} files to {res.out}: result.json, report.md" + "".join(f", {f.name}" for f in res.files), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
