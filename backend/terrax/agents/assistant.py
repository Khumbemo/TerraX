"""Offline assistant: small talk, follow-ups, TerraX help topics, unit
conversions, solar times and questions about the current results, without
any AI model.

The server keeps no conversation state. Each request carries the small
``state`` dict returned by the previous reply (last topic, pending detail).
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from ..processing.dates import format_date
from ..processing.stats import fmt, fmt_p
from ..services.solar import day_length_minutes, format_clock, solar_report
from .nlp import normalize, token_match, tokens, words

_KB = Path(__file__).with_name("knowledge.json")


@dataclass
class Topic:
    id: str
    title: str
    keywords: dict[str, float]
    answer: str
    phrases: list[re.Pattern] = field(default_factory=list)
    phrase_boost: float = 3.0
    more: str | None = None
    suggestions: list[str] | None = None
    compiled: list[list[tuple[str, float]]] = field(default_factory=list)


@lru_cache(maxsize=1)
def knowledge() -> tuple[list[Topic], list[str]]:
    data = json.loads(_KB.read_text(encoding="utf-8"))
    topics = []
    for t in data["topics"]:
        topic = Topic(
            id=t["id"],
            title=t["title"],
            keywords=t["keywords"],
            answer=t["answer"],
            phrases=[re.compile(p) for p in t.get("phrases", [])],
            phrase_boost=t.get("phraseBoost", 3),
            more=t.get("more"),
            suggestions=t.get("suggestions"),
        )
        # Multi-word keywords become token sequences; all tokens must match.
        # Synonyms can map two keywords to one token, so keep each token
        # sequence once (with its highest weight) to avoid counting a query
        # word twice.
        groups: dict[str, list[tuple[str, float]]] = {}
        for k, w in topic.keywords.items():
            g = [(tok, w) for tok in tokens(k)]
            if not g:
                continue
            key = " ".join(x[0] for x in g)
            prev = groups.get(key)
            if prev is None or prev[0][1] < w:
                groups[key] = g
        topic.compiled = list(groups.values())
        topics.append(topic)
    return topics, data["starter"]


def starter() -> list[str]:
    return knowledge()[1]


def topic_by_id(tid: str | None) -> Topic | None:
    return next((t for t in knowledge()[0] if t.id == tid), None) if tid else None


# ── Small talk ───────────────────────────────────────────────────────────────

RE = {
    "greet": re.compile(r"^(hi+|hello+|hey+|hiya|howdy|namaste|namaskar|hola|yo|hlo|helo|greetings|good (morning|afternoon|evening|day))\b"),
    "howAreYou": re.compile(r"\b(how are (you|u)|how r u|how('s| is) it going|how do you do|what'?s up|wassup|sup)\b"),
    "whoAreYou": re.compile(r"\b(who are you|what are you|your name|who made you|are you (a )?(bot|robot|ai|human|real))\b"),
    "capabilities": re.compile(r"\b(what can you do|what do you do|how can you help|what (can|should) i ask|capabilit|features?|^help$|help me|menu|options)\b"),
    "thanks": re.compile(r"\b(thanks?|thank ?you|thx|ty|appreciate|cheers)\b"),
    "praise": re.compile(r"^(great|awesome|nice|cool|perfect|good job|well done|amazing|excellent|wow|brilliant|super|love it)\b"),
    "bye": re.compile(r"\b(bye|goodbye|good ?night|see (you|ya)|cya|take care|that'?s all|exit|quit)\b"),
    "yes": re.compile(r"^(yes|yeah|yep|yup|sure|ok(ay)?|please( do)?|go ahead|y|of course|definitely)\b[.! ]*$"),
    "no": re.compile(r"^(no|nope|nah|not now|no thanks|never ?mind|cancel)\b[.! ]*$"),
    "frustrated": re.compile(r"\b(stupid|dumb|useless|bad|terrible|not helpful|doesn'?t understand|you don'?t understand|wrong answer|makes no sense)\b"),
    "more": re.compile(r"^(more|tell me more|go on|continue|explain( more| further)?|details?|elaborate|expand|why|how|how so|example|examples|and( then)?|then what|what else|what next|next)\b[?!. ]*$"),
    "time": re.compile(r"\b(what('s| is) the time|what time is it|current time|time now|the time\b)"),
    "date": re.compile(r"\b(what('s| is) (the )?date|today'?s date|what day is (it|today))\b"),
    "sun": re.compile(r"\b(sunrise|sunset|sun rise|sun set|day ?length|daylight|when does the sun)\b"),
}

RESULT_SUGGESTIONS = ["Summarise the results", "How was this calculated?", "How reliable is this?"]


@dataclass
class Context:
    target_lat: float = 20.0
    target_lon: float = 0.0
    target_name: str = "the telemetry target"
    operator: str | None = None
    now: datetime | None = None
    tz_offset_min: int = 0  # minutes east of UTC on the user's device
    results: dict[str, Any] | None = None  # {toolName, name, markdown, focus?}
    table: Any = None  # processing.table.Table for the results, when it is a table

    @property
    def local_now(self) -> datetime:
        return self._local(self.now or datetime.now(UTC))

    def _local(self, d: datetime) -> datetime:
        return d.astimezone(timezone(timedelta(minutes=self.tz_offset_min)))


def _name(ctx: Context) -> str:
    return f", {ctx.operator.split()[0]}" if ctx.operator and ctx.operator.split() else ""


def _time_greeting(local: datetime) -> str:
    h = local.hour
    return "Good morning" if h < 12 else "Good afternoon" if h < 17 else "Good evening"


# ── Unit conversion ──────────────────────────────────────────────────────────

_UNITS = [
    (re.compile(r"^(ha|hectares?)$"), "ha", 10_000.0),
    (re.compile(r"^(ac|acres?)$"), "acres", 4046.8564224),
    (re.compile(r"^(km2|km²|sq ?km|square kilomet(er|re)s?)$"), "km²", 1_000_000.0),
    (re.compile(r"^(m2|m²|sq ?m|square met(er|re)s?|sqm)$"), "m²", 1.0),
    (re.compile(r"^(ft2|ft²|sq ?ft|square f(ee|oo)t|sqft)$"), "sq ft", 0.09290304),
    (re.compile(r"^(mi2|sq ?mi|square miles?)$"), "sq mi", 2_589_988.110336),
]
_UNIT_WORD = r"(ha|hectares?|ac|acres?|km2|km²|sq ?km|square kilomet(?:er|re)s?|m2|m²|sq ?m|sqm|square met(?:er|re)s?|ft2|ft²|sq ?ft|sqft|square f(?:ee|oo)t|mi2|sq ?mi|square miles?)"
_CONV_A = re.compile(rf"(\d+(?:\.\d+)?)\s*{_UNIT_WORD}\s*(?:to|in|into|=|as)\s*{_UNIT_WORD}")
_CONV_B = re.compile(rf"how many\s*{_UNIT_WORD}\s*(?:are )?(?:in|per|make)\s*(?:an? |one )?(\d+(?:\.\d+)?)?\s*{_UNIT_WORD}")


def _find_unit(s: str):
    t = s.strip()
    return next((u for u in _UNITS if u[0].search(t)), None)


def convert(q: str) -> str | None:
    text = normalize(q).replace(",", "")
    m = _CONV_A.search(text)
    if m:
        value, frm, to = float(m.group(1)), _find_unit(m.group(2)), _find_unit(m.group(3))
    else:
        m = _CONV_B.search(text)
        if not m:
            return None
        to = _find_unit(m.group(1))
        value = float(m.group(2)) if m.group(2) else 1.0
        frm = _find_unit(m.group(3))
    if not frm or not to or not math.isfinite(value):
        return None
    out = value * frm[2] / to[2]
    return (
        f"**{fmt(value, 6)} {frm[1]} = {fmt(out, 6)} {to[1]}**\n\n"
        "(1 ha = 10,000 m² = 2.4711 acres; 1 acre = 4,046.86 m².) Local units such as the bigha vary by state, so I don’t convert them."
    )


# ── Topic matching ───────────────────────────────────────────────────────────


def score_topics(q: str) -> list[tuple[Topic, float]]:
    qt = tokens(q)
    norm = normalize(q)
    scored = []
    for topic in knowledge()[0]:
        score = 0.0
        for group in topic.compiled:
            # Every token of a (possibly multi-word) keyword must match somewhere.
            group_score = math.inf
            for tok, weight in group:
                best = max((token_match(t, tok) for t in qt), default=0.0)
                group_score = min(group_score, best * weight)
            if math.isfinite(group_score):
                score += group_score
        if any(rx.search(norm) for rx in topic.phrases):
            score += topic.phrase_boost
        if score > 0:
            scored.append((topic, score))
    scored.sort(key=lambda s: -s[1])  # stable, like Array.prototype.sort
    return scored


# ── Results lookup ───────────────────────────────────────────────────────────

_ROW = re.compile(r"^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|")
_BULLET = re.compile(r"^-\s+([^:]{2,60}):\s+(.+)$")


def table_rows(markdown: str) -> list[tuple[str, str]]:
    rows = []
    lines = markdown.split("\n")
    for line in lines:
        m = _ROW.match(line)
        if not m or re.fullmatch(r"-+", re.sub(r"\s", "", m.group(1))) or re.fullmatch(r"(statistic|measure|index|leg|year)", m.group(1), re.I):
            continue
        rows.append((m.group(1).replace("**", ""), m.group(2).replace("**", "")))
    # Bullet lines "- Label: value" are results too.
    for line in lines:
        m = _BULLET.match(line)
        if m and not re.match(r"(file|method|note)", m.group(1), re.I):
            rows.append((m.group(1), m.group(2)))
    return rows


def section(markdown: str, heading: str) -> str | None:
    for part in re.split(r"\n(?=## )", markdown):
        if part.startswith(f"## {heading}"):
            return re.sub(r"^## [^\n]*\n+", "", part).strip()
    return None


def _reply(text: str, suggestions: list[str], topic: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"text": text, "suggestions": suggestions}
    if topic:
        out["topic"] = topic
    return out


def _results_answer(q: str, ctx: Context) -> dict[str, Any] | None:
    r = ctx.results
    if not r:
        return None
    norm = normalize(q)
    md = str(r.get("markdown") or "")
    name = r.get("name") or "these results"

    if re.search(r"\b(summar|overview|results?|what did you find|findings|tell me about (it|this|the data)|explain (the )?(result|data|this))\b", norm) and not re.search(r"calculat|method", norm):
        res = section(md, "Results")
        return _reply(f"Here’s what TerraX found for **{name}**:\n\n{res or md}", RESULT_SUGGESTIONS, "results")
    if re.search(r"\b(how (was|is|were|did) (this|it|that|you)? ?(calculat|comput|measur|work)|method|formula|how accurate|accuracy|reliab|trust|limitation|caveat|uncertain)", norm):
        m = section(md, "Method and limits")
        return _reply(f"How it was computed, and its limits:\n\n{m}" if m else "The method notes are in the report below the results.", ["Summarise the results"], "results-method")

    ds = ctx.table
    if ds is not None:
        from ..processing.analysis import analyze_metric

        cols = ds.numeric_columns()
        column = next((c for c in cols if c.lower() in norm), None) or r.get("focus") or (cols[0] if cols else None)
        if column and column in cols:
            a = analyze_metric(ds, column)
            s = a.summary
            if s and a.points:
                max_pt = max(a.points, key=lambda p: p["value"])
                min_pt = min(a.points, key=lambda p: p["value"])
                if re.search(r"\b(trend|increas|decreas|chang|rising|falling|going up|going down|over time)\b", norm):
                    if not a.trend:
                        return _reply(f"There aren’t enough dated values in **{column}** for a trend test.", RESULT_SUGGESTIONS, "results")
                    verdict = "shows **no statistically significant trend**" if a.trend.direction == "no trend" else f"shows a **significant {a.trend.direction} trend**"
                    caveat = f"\n\nCaution: {a.trend_caveat}" if a.trend_caveat else ""
                    return _reply(
                        f"**{column}** {verdict} (Mann–Kendall p = {fmt_p(a.trend.p)}), with a Theil–Sen slope of {fmt(a.trend.sen_slope)} per year from {format_date(a.start)} to {format_date(a.end)}.{caveat}",
                        ["What does the trend test mean?", "Summarise the results"],
                        "results",
                    )
                if re.search(r"\b(season|seasonal|month|months|monthly|monsoon)\b", norm) and a.monthly:
                    valid = [m for m in a.monthly if math.isfinite(m["mean"])]
                    hi = max(valid, key=lambda m: m["mean"])
                    lo = min(valid, key=lambda m: m["mean"])
                    return _reply(f"Seasonal cycle of **{column}**: highest in **{hi['label']}** (mean {fmt(hi['mean'])}), lowest in **{lo['label']}** ({fmt(lo['mean'])}).", RESULT_SUGGESTIONS, "results")
                if re.search(r"\b(max|maximum|highest|peak|largest|biggest|wettest|hottest|most)\b", norm):
                    return _reply(f"The highest **{column}** is **{fmt(max_pt['value'])}** on {max_pt['label']}.", RESULT_SUGGESTIONS, "results")
                if re.search(r"\b(min|minimum|lowest|smallest|least|driest|coldest)\b", norm):
                    return _reply(f"The lowest **{column}** is **{fmt(min_pt['value'])}** on {min_pt['label']}.", RESULT_SUGGESTIONS, "results")
                if re.search(r"\b(mean|average|avg|typical|median)\b", norm):
                    return _reply(f"**{column}**: mean {fmt(s.mean)} ± {fmt(s.sd)} (SD), median {fmt(s.median)}, from {s.n} values.", RESULT_SUGGESTIONS, "results")
                if re.search(r"\b(how many|count|number of|records|rows|values)\b", norm):
                    span = f" from {format_date(a.start)} to {format_date(a.end)}" if ds.times else ""
                    return _reply(f"The file has {len(ds.rows)} rows; **{column}** has {s.n} numeric values{span}.", RESULT_SUGGESTIONS, "results")

    # Match the question against result rows (e.g. "how much forest was lost?" → "Forest loss").
    qt = tokens(q)
    if qt:
        best: tuple[tuple[str, str], float] | None = None
        for row in table_rows(md):
            lt = tokens(re.sub(r"\([^)]*\)", " ", row[0]))
            if not lt:
                continue
            hit = sum(max(token_match(t, l) for t in qt) for l in lt)
            score = hit / max(len(lt), 1) + hit * 0.1
            if best is None or score > best[1]:
                best = (row, score)
        if best and best[1] >= 0.75:
            return _reply(f"**{best[0][0]}:** {best[0][1]}", RESULT_SUGGESTIONS, "results")
    return None


# ── Engine ───────────────────────────────────────────────────────────────────


def _hhmm(d: datetime) -> str:
    return d.strftime("%H:%M")


def reply(question: str, ctx: Context, mode: str = "guide", state: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Answers one message. Returns (reply, new state)."""
    st = {"lastTopic": None, "pending": None, "gaveMore": False, **(state or {})}
    start = starter()
    last = topic_by_id(st["lastTopic"])
    now = ctx.now or datetime.now(UTC)
    local = ctx.local_now
    norm = normalize(question)
    word_count = len(words(question))
    scored = score_topics(question)
    top = scored[0] if scored else None
    has_topic = bool(top and top[1] >= 2)

    def topic_reply(t: Topic) -> dict[str, Any]:
        st.update(lastTopic=t.id, pending=t.more, gaveMore=False)
        offer = "\n\nWant more detail? Just say **yes** or ask a follow-up." if t.more else ""
        return _reply(f"{t.answer}{offer}", t.suggestions or start, t.id)

    def done(r: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        return r, st

    if not norm:
        return done(_reply("Ask me anything about TerraX or your data.", start))
    results = ctx.results if mode == "results" else None

    # 1. Short conversational turns.
    if RE["yes"].search(norm):
        if st["pending"]:
            text = st["pending"]
            st.update(pending=None, gaveMore=True)
            return done(_reply(text, (last.suggestions if last else None) or start, st["lastTopic"]))
        return done(_reply("Great. What would you like to do? Pick a tool below or ask a question.", start))
    if RE["no"].search(norm):
        st["pending"] = None
        return done(_reply("No problem. Ask whenever you need something.", start))
    if RE["greet"].search(norm) and word_count <= 5 and not has_topic:
        extra = f" I can see your **{results.get('toolName')}** results for {results.get('name')}; ask me about them." if results else ""
        return done(
            _reply(
                f"{_time_greeting(local)}{_name(ctx)}! I’m the TerraX assistant."
                f"{extra or ' I can walk you through the tools, explain remote-sensing terms, convert area units and tell you sunrise times.'} What would you like to do?",
                RESULT_SUGGESTIONS if results else start,
            )
        )
    if RE["howAreYou"].search(norm) and not has_topic:
        return done(_reply(f"I’m running smoothly, thanks for asking{_name(ctx)}! Ready to help with forest, land, climate or imagery analysis. What are you working on?", start))
    if RE["whoAreYou"].search(norm):
        return done(
            _reply(
                "I’m **TerraX’s built-in assistant**. I run on the TerraX server without any AI model: I recognise questions about the tools, "
                "remote-sensing and GIS terms, area units, sun times and your current results. I’m not a general AI model; for open-ended "
                "questions, turn on Gemini AI (a key in Settings, or GEMINI_API_KEY on the server).",
                ["What can you do?", "How do I set up AI?"],
            )
        )
    if RE["capabilities"].search(norm) and not has_topic:
        return done(
            _reply(
                "Here’s what I can help with, without any AI model:\n\n"
                "- **Tools:** forest loss and burn severity, carbon & biomass, land survey (upload or draw a plot), residential plot encroachment checks, weather & climate, satellite imagery, land cover, terrain and hydrology, photos\n"
                "- **Explain terms:** NDVI, EVI, NDWI, NBR, UTM/CRS, Mann–Kendall trends, IMD rainfall categories, hypsometric integral…\n"
                "- **Your results:** “summarise the results”, “what is the peak?”, “is there a trend?”\n"
                "- **Quick answers:** “convert 3 acres to hectares”, “when is sunrise?”, “what time is it?”\n"
                "- **Troubleshooting** upload errors\n\nJust ask in your own words.",
                start[1:],
            )
        )
    if RE["thanks"].search(norm) and word_count <= 6:
        return done(_reply(f"You’re welcome{_name(ctx)}! Anything else I can help with?", (last.suggestions if last else None) or start))
    if RE["praise"].search(norm) and word_count <= 5:
        return done(_reply("Glad that helped! What’s next?", (last.suggestions if last else None) or start))
    if RE["bye"].search(norm) and word_count <= 5:
        return done(_reply(f"Goodbye{_name(ctx)}! Your saved reports stay in the Reports tab. Come back any time.", []))
    if RE["frustrated"].search(norm) and not has_topic:
        return done(
            _reply(
                "Sorry about that. I’m a built-in assistant without an AI model, so I work best with specific questions, such as “how do I measure a plot?”, "
                "“what is NDVI?” or “summarise the results”. For free-form conversation, turn on AI in Settings with a Gemini API key.",
                ["What can you do?", "How do I set up AI?"],
            )
        )

    # 2. Live answers.
    conversion = convert(question)
    if conversion:
        return done(_reply(conversion, ["How do I measure a plot?"], "units"))
    if RE["time"].search(norm):
        s = solar_report(now, ctx.target_lat, ctx.target_lon)
        return done(
            _reply(
                f"It’s **{_hhmm(local)}** on your device ({_hhmm(now.astimezone(UTC))} UTC). At {ctx.target_name}, local mean solar time is {format_clock(s.mean_solar_time)[:5]}.",
                ["When is sunrise?", "What is solar time?"],
            )
        )
    if RE["date"].search(norm):
        return done(_reply(f"Today is **{local.strftime('%A')}, {local.day} {local.strftime('%B %Y')}**.", start))
    if RE["sun"].search(norm):
        s = solar_report(now, ctx.target_lat, ctx.target_lon)

        def t(d: datetime | None) -> str:
            if not d:
                return "none today (polar day or night)"
            dl = ctx._local(d)
            day = "" if dl.date() == local.date() else f"{dl.strftime('%a')} "
            return f"{day}{_hhmm(dl)} your time ({_hhmm(d)} UTC)"

        mins = day_length_minutes(s.sunrise, s.sunset)
        length = f"\n- Day length: {mins // 60} h {mins % 60} min" if mins is not None else ""
        where = "above" if s.altitude >= 0 else "below"
        return done(
            _reply(
                f"At **{ctx.target_name}** today:\n\n- Sunrise: {t(s.sunrise)}\n- Sunset: {t(s.sunset)}{length}\n- Sun now: {abs(s.altitude):.1f}° {where} the horizon\n\nChange the location in Settings → Telemetry target.",
                ["What does the telemetry panel show?"],
                "sun",
            )
        )

    # 3. Questions about the current results. Definition questions ("what is NDVI?") go to the glossary instead.
    definitional = bool(re.search(r"^(what (is|are|does)( an?| the)?|define|definition of|meaning of|what do you mean by|explain( what)?)\b", norm))
    strong_topic = bool(top and top[1] >= 3)
    if mode == "results" and not (definitional and strong_topic):
        r = _results_answer(question, ctx)
        if r:
            st.update(lastTopic=r.get("topic"), pending=None)
            return done(r)

    # 4. Follow-ups on the previous topic.
    if RE["more"].search(norm) and (not top or top[1] < 2) and last:
        if last.more and not st["gaveMore"]:
            st.update(pending=None, gaveMore=True)
            return done(_reply(last.more, last.suggestions or start, last.id))
        return done(_reply(f"That’s the main point about **{last.title.lower()}**. Related questions:", last.suggestions or start, last.id))

    # 5. Knowledge topics.
    if top and top[1] >= 2:
        second = scored[1] if len(scored) > 1 else None
        also = f"\n\n_Also related: {second[0].title.lower()}. Ask if you want that too._" if second and second[1] >= 2 and second[1] >= top[1] * 0.8 else ""
        r = topic_reply(top[0])
        r["text"] += also
        return done(r)
    if top and top[1] >= 1:
        return done(_reply("I’m not completely sure what you mean. Did you mean one of these?", [s[0].title for s in scored[:3]]))

    # 6. Nothing matched.
    if results:
        extra = ", such as the peak, mean or trend" if ctx.table is not None else ""
        text = f"I couldn’t match that to these results. Try “summarise the results”, “how was this calculated?” or ask about a specific value{extra}. For open-ended questions, turn on AI in Settings."
    else:
        text = "I didn’t catch that. I understand questions about TerraX’s tools, remote-sensing terms, area units and sun times. Try one of these, or turn on AI in Settings for open-ended questions."
    return done(_reply(text, ["Summarise the results", "How was this calculated?", "What can you do?"] if mode == "results" else start))
