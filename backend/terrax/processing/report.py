"""Builds the Markdown report (and AI context) from computed statistics.

Every number in a report comes from these calculations; an AI interpretation,
when present, is added as a separate, clearly labelled section.
"""

from __future__ import annotations

from .analysis import MetricAnalysis, analyze_metric
from .climate import rainfall_markdown, rainfall_summary, spi_class
from .dates import MONTHS, format_date
from .stats import fmt, fmt_p
from .table import Table


def format_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024**2:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024**2:.2f} MB"


def interval_text(days: float | None, min_days: float | None = None) -> str:
    if days is None:
        return "irregular or unknown"
    if min_days is not None and abs(min_days - 1) < 0.25 and days > 1.25:
        return "daily, with gaps between some records"
    if abs(days - 1) < 0.1:
        return "daily"
    if abs(days - 7) < 0.5:
        return "weekly"
    if 28 <= days <= 31:
        return "monthly"
    if 365 <= days <= 366:
        return "yearly"
    return f"every {fmt(days, 3)} days"


def _p_text(p: float) -> str:
    s = fmt_p(p)
    return f"p {s}" if s.startswith("<") else f"p = {s}"


def trend_sentence(a: MetricAnalysis) -> str:
    t = a.trend
    if not t:
        return "Not enough dated observations for a trend test (at least 4 are needed)."
    unit = f" {a.classification.unit}" if a.classification.unit and a.classification.convert(1) == 1 else ""
    verdict = (f"no statistically significant monotonic trend (Mann–Kendall p = {fmt_p(t.p)})" if t.direction == "no trend"
               else f"a statistically significant {t.direction} trend (Mann–Kendall p = {fmt_p(t.p)})")
    s = f"The series shows {verdict}. Theil–Sen slope: {fmt(t.sen_slope)}{unit} per year (least-squares slope {fmt(t.ols_slope)}{unit} per year), n = {t.n}."
    return f"{s} **Caution:** {a.trend_caveat}" if a.trend_caveat else s


def climate_markdown(a: MetricAnalysis) -> str:
    c = a.climate
    out: list[str] = []
    sk = c["seasonalKendall"]
    if sk:
        out.append(
            f"Seasonal Kendall test on {sk['n']} monthly values ({sk['seasons']} calendar months; Hirsch et al. 1982): "
            f"{'no significant trend' if sk['direction'] == 'no trend' else sk['direction'] + ' trend'}, seasonal Theil–Sen slope {fmt(sk['slope'])} per year, {_p_text(sk['p'])}. "
            "Unlike the plain Mann–Kendall test, it compares each month only with the same month in other years, so the seasonal cycle cannot pose as a trend. Serial correlation between months is not corrected for."
        )
    with_z = [x for x in c["anomalies"] if x["z"] is not None]
    if with_z:
        hi = max(with_z, key=lambda x: x["z"])
        lo = min(with_z, key=lambda x: x["z"])
        years = len({m.year for m in c["monthly"]})
        name = lambda x: f"{MONTHS[x['month']]} {x['year']}"
        out += ["", f"Monthly anomalies against this record’s own {years}-year monthly means: largest positive {name(hi)} ({fmt(hi['anomaly'])}, {fmt(hi['z'], 2)} SD), largest negative {name(lo)} ({fmt(lo['anomaly'])}, {fmt(lo['z'], 2)} SD)."
                + (" The WMO climate normal period is 30 years; a shorter baseline makes anomalies less stable." if years < 30 else "")]
    if c["spi"]:
        out += ["", "| SPI scale | Latest value | Months ≤ −1 (moderately dry or worse) | Months ≤ −2 |", "|---|---|---|---|"]
        for r in c["spi"]:
            vals = [x for x in r["rows"] if x["spi"] is not None]
            last = vals[-1] if vals else None
            latest = f"{fmt(last['spi'], 2)} ({MONTHS[last['month']]} {last['year']}, {spi_class(last['spi'])})" if last else "—"
            out.append(f"| SPI-{r['scale']} | {latest} | {sum(1 for x in vals if x['spi'] <= -1)} | {sum(1 for x in vals if x['spi'] <= -2)} |")
        first = c["spi"][0]["notes"]
        out += ["", *[f"- {n}" for n in first[1:]], "- SPI method: " + first[0].removeprefix("SPI-1: ")]
    elif c["spiNote"]:
        out += ["", c["spiNote"]]
    return "\n".join(out)


def metric_section(ds: Table, a: MetricAnalysis) -> str:
    s = a.summary
    if not s:
        return f"### {a.column}\n\nNo numeric values.\n"
    lines = [f"### {a.column}", "", "| Statistic | Value |", "|---|---|", f"| Valid values | {s.n} |", f"| Mean ± SD | {fmt(s.mean)} ± {fmt(s.sd)} |",
             f"| Median (IQR) | {fmt(s.median)} ({fmt(s.q1)}–{fmt(s.q3)}) |", f"| Range | {fmt(s.min)} to {fmt(s.max)} |"]
    if ds.times:
        lines.append(f"| Period | {format_date(a.start)} to {format_date(a.end)} |")
    lines.append("")
    if ds.times:
        lines += [trend_sentence(a), ""]
    rain = rainfall_summary(a.points, a.classification.metric, ds.min_interval_days, a.start, a.end)
    if rain:
        lines.append(rainfall_markdown(rain, a.start, a.end))
    if a.monthly and len(a.monthly) >= 6:
        hi = max(a.monthly, key=lambda m: m["mean"])
        lo = min(a.monthly, key=lambda m: m["mean"])
        lines += [f"Seasonal cycle: highest mean in {hi['label']} ({fmt(hi['mean'])}), lowest in {lo['label']} ({fmt(lo['mean'])}).", ""]
    if a.climate:
        lines += [climate_markdown(a), ""]
    total = sum(a.class_counts)
    if total:
        lines += [f"Class distribution ({a.classification.basis.rstrip('.')}):", ""]
        for b, n in zip(a.classification.buckets, a.class_counts):
            if n:
                lines.append(f"- {b['label']}: {n} ({n / total * 100:.1f} %)")
        if a.classification.note:
            lines += ["", f"Note: {a.classification.note}"]
        lines.append("")
    return "\n".join(lines)


def table_report(ds: Table, focus: str | None) -> str:
    cols = ds.numeric_columns()
    ordered = [focus, *[c for c in cols if c != focus]] if focus in cols else cols
    parts = ["## Dataset", "", f"- File: {ds.filename} ({ds.format}, {format_bytes(ds.size_bytes)})",
             f"- Records: {len(ds.rows)}; numeric columns: {', '.join(cols) or 'none'}",
             f"- Time column: {ds.time_column}; sampling {interval_text(ds.interval_days, ds.min_interval_days)}" if ds.time_column else "- No time column",
             "", "## Results", "", *[metric_section(ds, analyze_metric(ds, c)) for c in ordered[:6]]]
    if len(ordered) > 6:
        parts += [f"({len(ordered) - 6} further columns not summarised.)", ""]
    return "\n".join(parts)


METHOD_NOTE = "\n".join([
    "## Method and limits", "",
    "- Statistics are computed by the TerraX processing server from the uploaded values; empty, non-numeric and no-data values are excluded.",
    "- Trend: Mann–Kendall test (two-sided, α = 0.05, tie-corrected) with the Theil–Sen slope. It assumes independent observations; strong seasonality or autocorrelation can make p-values too small, so check the seasonal cycle before reading a trend as real.",
    "- Value classes are indicative and depend on sensor, season and region; the basis for each is stated with it.",
])


def with_quality(body: str, warnings: list[str]) -> str:
    q = "\n".join(["## Data quality", "", *[f"- {w}" for w in warnings], ""]) if warnings else ""
    return "\n".join(x for x in (body, q, METHOD_NOTE) if x)


def table_ai_context(ds: Table, report: str, max_rows: int = 150) -> str:
    cols = [c for c in [ds.time_column, *ds.numeric_columns()] if c][:8]
    step = max(1, -(-len(ds.rows) // max_rows))
    sample = ds.rows[::step][:max_rows]

    def cell(v):
        return v.isoformat() if hasattr(v, "isoformat") else "" if v is None else (f"{v:g}" if isinstance(v, float) else str(v))

    csv_text = "\n".join([",".join(cols), *[",".join(cell(r.get(c)) for c in cols) for r in sample]])
    extra = f", every {step}th row" if step > 1 else ""
    return "\n\n".join([report, f"## Data sample ({len(sample)} of {len(ds.rows)} rows{extra})", "```csv", csv_text, "```"])
