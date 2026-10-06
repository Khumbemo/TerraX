"""Date parsing for tabular time series (UTC calendar dates)."""

from __future__ import annotations

import calendar
import re
from collections.abc import Iterable
from datetime import date, datetime, timedelta
from itertools import pairwise
from typing import Any

ISO = re.compile(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$")
YEAR_MONTH = re.compile(r"^(\d{4})[-/.](\d{1,2})$")
YEAR_DOY = re.compile(r"^(\d{4})[-.]?(\d{3})$")
YEAR_ONLY = re.compile(r"^(\d{4})$")
SHORT_FIRST = re.compile(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$")
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def _utc(year: int, month: int, day: int) -> date | None:
    if month < 1 or month > 12 or day < 1 or day > days_in_month(year, month):
        return None
    return date(year, month, day)


def detect_day_month_order(values: Iterable[Any]) -> tuple[str, bool]:
    """'DMY' or 'MDY' for dd-mm-yyyy style values, and whether the choice was ambiguous."""
    first = second = False
    for v in values:
        if not isinstance(v, str):
            continue
        m = SHORT_FIRST.match(v.strip())
        if not m:
            continue
        first |= int(m.group(1)) > 12
        second |= int(m.group(2)) > 12
    if first:
        return "DMY", False
    if second:
        return "MDY", False
    return "DMY", True


def parse_date_cell(value: Any, order: str = "DMY", year_column: bool = False) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if year_column and float(value).is_integer() and 1000 <= value <= 3000:
            return date(int(value), 1, 1)
        return None
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    if m := ISO.match(s):
        return _utc(int(m[1]), int(m[2]), int(m[3]))
    if m := SHORT_FIRST.match(s):
        a, b, y = int(m[1]), int(m[2]), int(m[3])
        return _utc(y, b, a) if order == "DMY" else _utc(y, a, b)
    if m := YEAR_DOY.match(s):
        year, doy = int(m[1]), int(m[2])
        if doy < 1 or doy > (366 if calendar.isleap(year) else 365):
            return None
        return date(year, 1, 1) + timedelta(days=doy - 1)
    if m := YEAR_MONTH.match(s):
        return _utc(int(m[1]), int(m[2]), 1)
    if m := YEAR_ONLY.match(s):
        return _utc(int(m[1]), 1, 1)
    return None


def decimal_year(d: date) -> float:
    start = date(d.year, 1, 1)
    end = date(d.year + 1, 1, 1)
    return d.year + (d - start).days / (end - start).days


def format_date(d: date | None) -> str:
    return d.isoformat() if d else "—"


def date_spacing(dates: Iterable[date | None]) -> tuple[float, float] | None:
    """(median, min) gap in days between consecutive distinct dates, or None."""
    t = sorted({d.toordinal() for d in dates if d is not None})
    gaps = sorted(b - a for a, b in pairwise(t))
    if not gaps:
        return None
    mid = len(gaps) // 2
    median = gaps[mid] if len(gaps) % 2 else (gaps[mid - 1] + gaps[mid]) / 2
    return float(median), float(gaps[0])


def date_from_filename(name: str) -> date | None:
    """2024-03-15, 2024_03_15, 20240315 or 2024-075 (day of year) in a file name."""
    s = re.sub(r"\.[^.]+$", "", name)
    m = re.search(r"(?:^|[^\d])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)", s)
    if m and (d := _utc(int(m[1]), int(m[2]), int(m[3]))):
        return d
    m = re.search(r"(?:^|[^\d])((?:19|20)\d{2})[-_]?(\d{3})(?!\d)", s)
    if m and 1 <= int(m[2]) <= 366:
        return date(int(m[1]), 1, 1) + timedelta(days=int(m[2]) - 1)
    return None
