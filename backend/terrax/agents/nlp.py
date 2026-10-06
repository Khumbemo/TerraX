"""Lightweight text understanding for the offline assistant: normalisation,
tokenising, light stemming, synonyms and typo-tolerant word matching."""

from __future__ import annotations

import re

_CONTRACTIONS = [
    (r"\bwhat's\b", "what is"),
    (r"\bhow's\b", "how is"),
    (r"\bit's\b", "it is"),
    (r"\bi'm\b", "i am"),
    (r"\byou're\b", "you are"),
    (r"\bcan't\b", "can not"),
    (r"\bdon't\b", "do not"),
    (r"\bdoesn't\b", "does not"),
    (r"\bisn't\b", "is not"),
    (r"\bwon't\b", "will not"),
    (r"\bi've\b", "i have"),
    (r"\bthat's\b", "that is"),
    (r"\bwhere's\b", "where is"),
]
_CONTRACTIONS_RE = [(re.compile(p), r) for p, r in _CONTRACTIONS]

STOPWORDS = set(
    "a an the is are was were be been being am i me my we our you your it its this that these those of to in on at for from by with "
    "and or but if then so do does did can could would should will shall may might must about into over please pls kindly just tell "
    "show give explain know want need like get let us some any there here what which who whom whose how why when where".split()
)

# Words that change meaning a lot; kept even though they are short.
KEEP_SHORT = {"ai", "et", "rh", "sm", "kp", "gee", "dem", "crs", "utm", "lst", "nir", "pdf", "csv", "kml", "gpx", "imd", "evi", "nbr", "hi", "ok", "no"}

_SYN_GROUPS = {
    "hi": "hello hey hiya howdy namaste greetings yo hlo helo",
    "thanks": "thank thx ty thankyou cheers",
    "bye": "bye goodbye cya",
    "loss": "lost losing cleared",
    "gain": "gained regrowth",
    "forest": "deforestation trees tree woodland canopy logging",
    "survey": "plot boundary parcel field land traverse perimeter",
    "rainfall": "rain precipitation precip monsoon rainy",
    "temperature": "temp hot cold heat",
    "humidity": "humid",
    "moisture": "moist",
    "imagery": "image images",
    "photo": "picture photos pic photograph drone jpg jpeg png",
    "satellite": "satellite sentinel landsat scene multispectral",
    "dem": "elevation height altitude terrain topography relief srtm hill mountain",
    "slope": "steep gradient incline",
    "upload": "upload load import open add drop attach",
    "file": "file files format formats data dataset",
    "report": "report reports pdf markdown export download save",
    "ai": "ai gemini key apikey llm chatgpt",
    "trend": "trend trends increasing decreasing mann kendall sen slope_trend",
    "sunrise": "sunrise dawn",
    "sunset": "sunset dusk",
    "time": "time clock",
    "date": "date today",
    "area": "area acreage size",
    "hectare": "hectare hectares ha",
    "acre": "acre acres",
    "map": "map basemap tiles",
    "gee": "earthengine engine",
    "shapefile": "shp shapefiles",
    "tif": "geotiff tiff raster rasters",
    "error": "wrong broken fail failed bug crash stuck problem issue",
}
SYNONYMS = {w: canon for canon, ws in _SYN_GROUPS.items() for w in ws.split()}

_SUFFIXES = ["ations", "ation", "ings", "ing", "edly", "ed", "ies", "es", "ly", "s"]


def stem(w: str) -> str:
    """Very light English stemmer: enough to join "computing/computed/computes"."""
    if len(w) <= 4:
        return w
    for suf in _SUFFIXES:
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            base = w[: -len(suf)]
            return base + "y" if suf == "ies" else base
    return w


def normalize(text: str) -> str:
    t = re.sub(r"[’‘]", "'", text.lower())
    for rx, rep in _CONTRACTIONS_RE:
        t = rx.sub(rep, t)
    t = t.replace("earth engine", "earthengine").replace("api key", "apikey").replace("thank you", "thankyou").replace("shape file", "shapefile")
    t = re.sub(r"[^a-z0-9²\s.\-]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def words(text: str) -> list[str]:
    """Raw words (after normalisation), including stopwords."""
    out = []
    for w in normalize(text).split(" "):
        w = re.sub(r"^[.\-]+|[.\-]+$", "", w)
        if w:
            out.append(w)
    return out


def tokens(text: str) -> list[str]:
    """Content tokens: stopwords removed, synonyms mapped, stemmed."""
    out = []
    for w in words(text):
        if w in STOPWORDS:
            continue
        if len(w) < 3 and w not in KEEP_SHORT and not w[0].isdigit():
            continue
        s = stem(w)
        out.append(SYNONYMS.get(w) or SYNONYMS.get(s) or s)
    return out


def edit_distance(a: str, b: str, max_d: int = 2) -> int:
    """Damerau–Levenshtein (optimal string alignment) distance with an early exit above ``max_d``."""
    if abs(len(a) - len(b)) > max_d:
        return max_d + 1
    d = [[i] + [0] * len(b) for i in range(len(a) + 1)]
    for j in range(1, len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        row_min = float("inf")
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
            row_min = min(row_min, d[i][j])
        if row_min > max_d:
            return max_d + 1
    return d[len(a)][len(b)]


def token_match(q: str, k: str) -> float:
    """1 for an exact match, 0.9 for a shared prefix of 5+ letters, 0.8 for a
    likely typo (one edit for 5–7 letters, two for 8+), 0 otherwise. Short
    words must match exactly, because one edit turns many of them into other
    words (file → fire)."""
    if q == k:
        return 1.0
    if len(q) >= 5 and len(k) >= 5 and (q.startswith(k) or k.startswith(q)):
        return 0.9
    if len(q) < 5 or len(k) < 5:
        return 0.0
    allowed = 2 if min(len(q), len(k)) >= 8 else 1
    return 0.8 if edit_distance(q, k, allowed) <= allowed else 0.0
