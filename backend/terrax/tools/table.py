"""Weather & climate: tabular time series (CSV, TSV, XLSX)."""

from __future__ import annotations

from ..processing.analysis import analyze_metric
from ..processing.report import table_ai_context, table_report, with_quality
from ..processing.table import read_table
from . import tool
from .common import clean
from .context import ToolContext, ToolError


@tool("table")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    f = ctx.file(inputs.get("file"))
    if f is None:
        raise ToolError("Choose a CSV, TSV or XLSX file.")
    if f.kind != "table":
        raise ToolError(f"{f.name} is not a table TerraX can read (CSV, TSV or XLSX).")
    t = read_table(f.path, f.name)
    focus = params.get("focus") or t.default_metric
    ctx.progress(0.4, "Computing statistics and trends")
    cols = t.numeric_columns()
    analyses = {c: analyze_metric(t, c).public() for c in cols[:12]}
    md = with_quality(table_report(t, focus), t.warnings)
    return clean({"tool": "weather", "name": f.name, "markdown": md, "extraContext": table_ai_context(t, md), "dataset": t.summary(), "focus": focus, "analyses": analyses})
