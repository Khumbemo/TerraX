"""Built-in assistant and Gemini request handling (ported from the TypeScript tests)."""

from datetime import datetime, timezone

import pytest

from terrax.agents import assistant, gemini
from terrax.agents.nlp import token_match, tokens
from terrax.processing.report import table_report, with_quality
from terrax.processing.table import read_table

from .conftest import SAMPLES

NOW = datetime(2026, 9, 28, 4, 0, tzinfo=timezone.utc)


def ctx(**kw):
    return assistant.Context(target_lat=25.674, target_lon=94.108, target_name="Kohima", operator="Asha Rao", now=NOW, tz_offset_min=330, **kw)


class Bot:
    def __init__(self, mode="guide"):
        self.mode, self.state = mode, {}

    def ask(self, q, c=None):
        r, self.state = assistant.reply(q, c or ctx(), self.mode, self.state)
        return r


def test_small_talk():
    a = Bot()
    assert a.ask("hi")["text"].startswith("Good morning, Asha!")  # 09:30 in India
    assert "TerraX assistant" in a.ask("Hello there")["text"]
    assert "thanks for asking" in a.ask("how are you?")["text"]
    assert "built-in assistant" in a.ask("who are you")["text"]
    assert "what I can help with" in a.ask("what can you do")["text"]
    assert "welcome" in a.ask("thanks!")["text"]
    assert "Goodbye" in a.ask("ok bye")["text"]
    assert "Sorry" in a.ask("you are dumb")["text"]
    assert "didn’t catch that" in a.ask("asdfgh")["text"]


@pytest.mark.parametrize(
    "q,topic",
    [
        ("how do i calcualte forest los", "forest"), ("what is ndvi", "ndvi"), ("whats the Normalized Difference Vegetation Index", "ndvi"),
        ("measure my plot", "survey"), ("how big is my field", "survey"), ("my shapefile wont load", "errors"), ("is my data safe", "privacy"),
        ("whats utm", "crs"), ("what is kp", "kp"), ("burn severity", "nbr"), ("rain categories", "imd"), ("soil moistur", "soil"),
        ("how steep is too steep", "slopeclass"), ("hansen lossyear", "hansen"), ("open water index", "ndwi"),
        ("how do I export from earth engine", "gee"), ("set up gemini api key", "ai"), ("what does the mann kendall p value mean", "trend"),
        ("can i upload kml files", "formats"), ("what is hypsometric integral", "hypsometric"), ("how do I estimate carbon stock", "carbon"),
        ("calculate biomass from dbh and height", "carbon"), ("import my forest capture data", "carbon"), ("what wood density should I use", "wooddensity"),
        ("clip forest loss to my plot boundary", "aoi"), ("only analyse pixels inside my plot", "aoi"), ("can I draw a polygon on the map", "draw"),
        ("export my boundary as kml", "draw"), ("how much forest was lost", "forest"), ("how do I delineate a watershed", "hydrology"),
        ("can you draw contour lines", "hydrology"), ("classify land cover from my image", "landcover"), ("how do I remove clouds", "cloudmask"),
        ("what is a minimum mapping unit", "mmu"), ("can I download rainfall data from era5", "livedata"), ("find sentinel scenes for my area", "livedata"),
        ("what does spi mean for drought", "spi"), ("explain the seasonal kendall test", "seasonalkendall"), ("monthly anomalies", "seasonalkendall"),
        ("my neighbour built on my land", "encroachment"), ("how to detect encroachment on my plot", "encroachment"),
        ("illegal construction next to my property", "encroachment"), ("how do I switch to openstreetmap", "map"), ("change the base map to satellite", "map"),
    ],
)
def test_topic_routing(q, topic):
    assert Bot().ask(q).get("topic") == topic


def test_follow_ups_use_state():
    a = Bot()
    assert "Want more detail" in a.ask("what is ndvi")["text"]
    assert "saturates" in a.ask("yes")["text"]
    assert "main point" in a.ask("how?")["text"]
    assert a.ask("and evi?").get("topic") == "evi"
    b = Bot()
    b.ask("how do I estimate forest loss")
    assert "same season" in b.ask("tell me more")["text"]
    assert "No problem" in Bot().ask("no thanks")["text"]


def test_units_time_and_sunrise():
    a = Bot()
    assert "2.5 acres = 1.01171 ha" in a.ask("convert 2.5 acres to hectares")["text"]
    assert "1 ha = 2.47105 acres" in a.ask("how many acres in a hectare")["text"]
    assert "= 0.5 ha" in a.ask("5000 m2 in ha")["text"]
    t = a.ask("what time is it")["text"]
    assert "**09:30**" in t and "04:00 UTC" in t
    sun = a.ask("when is sunrise")
    assert sun["topic"] == "sun"
    # Kohima sunrise ≈ 05:05 IST (23:35 UTC the previous day) on 28 Sep.
    assert "Sunrise: 05:0" in sun["text"] and "(23:3" in sun["text"]
    assert "Today is **Monday, 28 September 2026**" in a.ask("what is the date")["text"]


def test_results_assistant_answers_from_results():
    ds = read_table(SAMPLES / "ndvi_data.csv")
    results = {"toolName": "Satellite imagery", "name": "ndvi_data.csv", "markdown": with_quality(table_report(ds, "NDVI"), ds.warnings), "focus": "NDVI"}
    a = Bot("results")
    c = ctx(results=results, table=ds)
    assert "I can see your **Satellite imagery** results" in a.ask("hi", c)["text"]
    assert "highest **NDVI** is **0.8703**" in a.ask("what is the peak", c)["text"]
    assert "lowest **NDVI** is **0.5327**" in a.ask("lowest value?", c)["text"]
    assert "Mann–Kendall p = " in a.ask("is there a trend", c)["text"]
    assert "Seasonal cycle" in a.ask("which month is highest", c)["text"]
    assert "Here’s what TerraX found" in a.ask("summarise the results", c)["text"]
    assert "limits" in a.ask("how reliable is this", c)["text"]
    forest = {
        "toolName": "Forest loss", "name": "a vs b",
        "markdown": "## Results\n\n| Measure | Value |\n|---|---|\n| Forest at start (NDVI ≥ 0.5) | 3,911 ha |\n| Forest loss (ΔNDVI ≤ -0.2) | 184.05 ha |\n\n## Method and limits\n\n- NDVI thresholds are a proxy.",
    }
    r = Bot("results").ask("how much forest was lost", ctx(results=forest))
    assert "Forest loss" in r["text"] and "184.05 ha" in r["text"]
    forest2 = {**forest, "markdown": forest["markdown"] + "\n| Mean ΔNDVI (all valid pixels) | -0.011 |"}
    assert Bot("results").ask("what is ndvi", ctx(results=forest2)).get("topic") == "ndvi"


def test_typo_matching():
    assert token_match("file", "fire") == 0
    assert token_match("moistur", "moisture") == 0.9
    assert token_match("calcualte", "calculate") == 0.8
    assert tokens("How do I upload a GeoTIFF?") == ["upload", "tif"]


def test_gemini_request_validation():
    with pytest.raises(gemini.RequestValidationError):
        gemini.sanitize_turns([])
    with pytest.raises(gemini.RequestValidationError):
        gemini.sanitize_turns([{"role": "model", "text": "hi"}])
    with pytest.raises(gemini.RequestValidationError):
        gemini.sanitize_turns([{"role": "user", "text": "x" * 200_000}])
    assert gemini.pick_model("evil; drop") == "gemini-2.5-flash"
    assert "rate limit" in gemini.describe_error("429 RESOURCE_EXHAUSTED")
    assert "rejected the API key" in gemini.describe_error("API key not valid")


def test_chat_api_without_key_uses_built_in(client):
    r = client.post("/api/agents/chat", json={"agent": "guide", "question": "what is ndvi", "tzOffsetMinutes": 330})
    assert r.status_code == 200
    j = r.json()
    assert j["engine"] == "built-in" and "NDVI" in j["text"] and j["state"]["lastTopic"] == "ndvi"
    j2 = client.post("/api/agents/chat", json={"agent": "guide", "question": "yes", "state": j["state"]}).json()
    assert "saturates" in j2["text"]
    assert client.get("/api/agents/status").json()["configured"] is False
    assert client.post("/api/agents/interpret", json={"toolName": "x", "markdown": "y"}).status_code == 503


def test_chat_api_results_with_table(client):
    fid = client.post("/api/samples", json={"name": "ndvi_data.csv"}).json()["id"]
    res = client.post("/api/jobs", json={"tool": "table", "inputs": {"file": fid}, "params": {"focus": "NDVI"}}).json()["result"]
    body = {"agent": "results", "question": "what is the peak", "results": {"toolName": "Weather & climate", "name": "ndvi_data.csv", "markdown": res["markdown"], "fileId": fid, "focus": "NDVI"}}
    assert "0.8703" in client.post("/api/agents/chat", json=body).json()["text"]


def test_chat_api_gemini_failure_falls_back(client, monkeypatch):
    def boom(key, req):
        raise gemini.GeminiError("The Gemini API rejected the API key.")

    monkeypatch.setattr(gemini, "generate", boom)
    j = client.post("/api/agents/chat", json={"question": "what is ndvi"}, headers={"X-Gemini-Key": "bad"}).json()
    assert j["engine"] == "built-in" and "AI request failed" in j["text"] and "NDVI" in j["text"]

    seen = {}

    def ok(key, req):
        seen.update(key=key, system=req.system_instruction, turns=req.turns)
        return gemini.GenerateResult(text="Gemini says hi", model=req.model, sources=[{"uri": "https://example.org", "title": "example.org"}])

    monkeypatch.setattr(gemini, "generate", ok)
    j = client.post("/api/agents/chat", json={"question": "hello", "history": [{"role": "user", "text": "a"}, {"role": "model", "text": "b"}]}, headers={"X-Gemini-Key": "k"}).json()
    assert j["engine"] == "gemini" and j["text"] == "Gemini says hi" and seen["key"] == "k"
    assert "TerraX OS Guide" in seen["system"] and len(seen["turns"]) == 3
