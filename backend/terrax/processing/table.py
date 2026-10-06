"""Reads CSV, TSV and XLSX tables into a typed dataset with a time axis."""

from __future__ import annotations

import csv
import io
import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any

from .dates import date_spacing, detect_day_month_order, parse_date_cell
from .metrics import is_known_metric, tokenize

MAX_ROWS = 200_000
TIME_NAME = re.compile(r"date|time|year|day|period|month|timestamp", re.I)
NUMERIC = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")
MISSING = re.compile(r"^(nan|na|n/a|null|none)$", re.I)


@dataclass
class Table:
    filename: str
    format: str
    size_bytes: int
    columns: list[dict]
    rows: list[dict[str, Any]]
    time_column: str | None
    times: list[date | None] | None
    interval_days: float | None
    min_interval_days: float | None
    default_metric: str | None
    warnings: list[str] = field(default_factory=list)

    def numeric_columns(self) -> list[str]:
        return [c["name"] for c in self.columns if c["kind"] == "number" and c["name"] != self.time_column]

    def summary(self) -> dict:
        """What the UI needs to choose columns (no row data)."""
        return {
            "kind": "table", "filename": self.filename, "format": self.format, "sizeBytes": self.size_bytes,
            "columns": self.columns, "rowCount": len(self.rows), "timeColumn": self.time_column,
            "intervalDays": self.interval_days, "minIntervalDays": self.min_interval_days,
            "defaultMetric": self.default_metric, "numericColumns": self.numeric_columns(), "warnings": self.warnings,
        }


def _empty(v: Any) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "") or (isinstance(v, float) and math.isnan(v))


def normalise_cell(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    if not s:
        return None
    if NUMERIC.match(s):
        return float(s)
    if MISSING.match(s):
        return None
    return s


def _unique_headers(raw: list[Any]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for i, h in enumerate(raw):
        name = f"column_{i + 1}" if _empty(h) else str(h).strip()
        c = seen.get(name, 0)
        seen[name] = c + 1
        out.append(f"{name}_{c + 1}" if c else name)
    return out


def build_table(filename: str, fmt_name: str, size: int, matrix: list[list[Any]]) -> Table:
    warnings: list[str] = []
    rows_raw = [r for r in matrix if any(not _empty(c) for c in r)]
    if len(rows_raw) < 2:
        raise ValueError("The file needs a header row and at least one data row.")
    headers = _unique_headers(list(rows_raw[0]))
    body = rows_raw[1:]
    if len(body) > MAX_ROWS:
        warnings.append(f"Only the first {MAX_ROWS:,} of {len(body):,} rows were loaded.")
        body = body[:MAX_ROWS]
    rows = [{h: normalise_cell(r[i] if i < len(r) else None) for i, h in enumerate(headers)} for r in body]

    columns = []
    for name in headers:
        vals = [r[name] for r in rows if r[name] is not None]
        numeric = sum(1 for v in vals if isinstance(v, float))
        date_like = sum(1 for v in vals if isinstance(v, date) or (isinstance(v, str) and parse_date_cell(v) is not None))
        kind = "text"
        if vals and date_like / len(vals) >= 0.8:
            kind = "date"
        elif vals and numeric / len(vals) >= 0.8:
            kind = "number"
        columns.append({"name": name, "kind": kind, "filled": len(vals)})

    time_col = next((c["name"] for c in columns if c["kind"] == "date"), None)
    year_col = None
    if not time_col:
        year_col = next((c for c in columns if c["kind"] == "number" and "year" in tokenize(c["name"])), None)
        if year_col:
            time_col = year_col["name"]
    if not time_col:
        named = next((c for c in columns if TIME_NAME.search(c["name"])), None)
        if named:
            warnings.append(f'Column "{named["name"]}" looks like a date column, but most of its values could not be read as dates.')

    times = interval = min_interval = None
    if time_col:
        raw = [r[time_col] for r in rows]
        order, ambiguous = detect_day_month_order(raw)
        times = [parse_date_cell(v, order, bool(year_col)) for v in raw]
        bad = sum(1 for t, v in zip(times, raw, strict=True) if t is None and v is not None)
        if bad:
            warnings.append(f'{bad} value{"" if bad == 1 else "s"} in "{time_col}" are not valid calendar dates and were left off the time axis.')
        if ambiguous and any(isinstance(v, str) and re.match(r"^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$", v.strip()) for v in raw):
            warnings.append(f'Dates in "{time_col}" could be day-first or month-first; they were read as day-month-year.')
        sp = date_spacing(times)
        interval, min_interval = (sp if sp else (None, None))
        prev = None
        for t in times:
            if t and prev and t < prev:
                warnings.append("Rows are not in time order; charts plot them in time order.")
                break
            if t:
                prev = t
    else:
        warnings.append("No date or time column was found, so rows are plotted in file order and trend tests are unavailable.")

    numeric_cols = [c for c in columns if c["kind"] == "number" and c["name"] != time_col]
    if not numeric_cols:
        warnings.append("No numeric columns were found to analyse.")
    id_like = lambda n: any(t in ("id", "fid", "index") for t in tokenize(n))
    default = next((c["name"] for c in numeric_cols if is_known_metric(c["name"])), None) or next((c["name"] for c in numeric_cols if not id_like(c["name"])), None) or (numeric_cols[0]["name"] if numeric_cols else None)
    for c in numeric_cols:
        missing = len(rows) - c["filled"]
        if missing > 0:
            warnings.append(f'"{c["name"]}" has {missing} empty or non-numeric value{"" if missing == 1 else "s"}; they are excluded from statistics.')
    return Table(filename, fmt_name, size, columns, rows, time_col, times, interval, min_interval, default, warnings)


def read_table(path: Path, filename: str | None = None) -> Table:
    filename = filename or path.name
    size = path.stat().st_size
    ext = path.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook

        wb = load_workbook(path, read_only=True, data_only=True)
        ws = wb.worksheets[0]
        matrix = [list(r) for r in ws.iter_rows(values_only=True)]
        t = build_table(filename, "XLSX", size, matrix)
        if len(wb.worksheets) > 1:
            t.warnings.append("Only the first worksheet was read.")
        return t
    text = path.read_bytes().decode("utf-8-sig", errors="replace")
    delimiter = "\t" if ext == ".tsv" or (ext != ".csv" and text.count("\t") > text.count(",")) else None
    if delimiter is None:
        try:
            delimiter = csv.Sniffer().sniff(text[:20000], delimiters=",;|\t").delimiter
        except csv.Error:
            delimiter = ","
    matrix = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    widths = [len(r) for r in matrix if r]
    t = build_table(filename, "TSV" if delimiter == "\t" else "CSV", size, matrix)
    if widths:
        bad = sum(1 for w in widths[1:] if w != widths[0])
        if bad:
            t.warnings.insert(0, f"{bad} row{' was' if bad == 1 else 's were'} malformed (a different number of fields from the header).")
    return t
