"""Assistant endpoints: the built-in assistant and the Gemini agents.

``POST /api/agents/chat`` answers with Gemini when a key is available (the
server's GEMINI_API_KEY, or the user's own key in the ``X-Gemini-Key``
header) and falls back to the built-in assistant otherwise, or when Gemini
fails. The server keeps no chat history: the client sends recent turns and
the assistant's small state object back with each question.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from ..agents import assistant, gemini
from ..agents.prompts import DATA_SYSTEM_PROMPT, GUIDE_SYSTEM_PROMPT, REPORT_PROMPT
from ..config import settings

router = APIRouter(prefix="/api/agents", tags=["agents"])

RATE_LIMIT = 20  # Gemini requests per minute per client
_hits: dict[str, deque[float]] = defaultdict(deque)


def _rate_limited(client: str) -> bool:
    now = time.monotonic()
    q = _hits[client]
    while q and now - q[0] > 60:
        q.popleft()
    q.append(now)
    return len(q) > RATE_LIMIT


def _key(header_key: str | None) -> str:
    return (header_key or "").strip() or settings().gemini_api_key


@router.get("/status")
def status() -> dict[str, Any]:
    s = settings()
    return {"configured": bool(s.gemini_api_key), "defaultModel": s.gemini_model}


class Target(BaseModel):
    lat: float = 25.674
    lon: float = 94.108
    name: str = "Kohima"


class Results(BaseModel):
    toolName: str = ""
    name: str = ""
    markdown: str = ""
    extraContext: str | None = None
    fileId: str | None = None
    focus: str | None = None


class ChatRequest(BaseModel):
    agent: Literal["guide", "results"] = "guide"
    question: str = Field(max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list)
    target: Target = Field(default_factory=Target)
    operator: str | None = None
    tzOffsetMinutes: int = Field(0, ge=-14 * 60, le=14 * 60)
    now: datetime | None = None
    results: Results | None = None
    state: dict[str, Any] = Field(default_factory=dict)
    model: str | None = None
    useAi: bool = True


def _table_for(results: Results | None):
    if not results or not results.fileId:
        return None
    from .. import storage
    from ..processing.table import read_table

    try:
        f = storage.get_file(results.fileId)
    except KeyError:
        return None
    return read_table(f.path, f.name) if f.kind == "table" else None


def _offline(req: ChatRequest, note: str = "") -> dict[str, Any]:
    ctx = assistant.Context(
        target_lat=req.target.lat,
        target_lon=req.target.lon,
        target_name=req.target.name,
        operator=req.operator,
        now=req.now or datetime.now(timezone.utc),
        tz_offset_min=req.tzOffsetMinutes,
        results=req.results.model_dump() if req.results else None,
        table=_table_for(req.results) if req.agent == "results" else None,
    )
    r, state = assistant.reply(req.question, ctx, req.agent, req.state)
    return {"text": note + r["text"], "suggestions": r["suggestions"], "sources": [], "state": state, "engine": "built-in"}


@router.post("/chat")
def chat(req: ChatRequest, request: Request, x_gemini_key: str | None = Header(default=None)) -> dict[str, Any]:
    key = _key(x_gemini_key)
    if not req.useAi or not key:
        return _offline(req)
    if _rate_limited(request.client.host if request.client else "unknown"):
        return _offline(req, "_Too many AI requests in the last minute, so this is the built-in answer._\n\n")
    if req.agent == "results":
        r = req.results
        context = f"Tool: {r.toolName}\n\n{r.extraContext or r.markdown}" if r else "No results yet."
        system = f"{DATA_SYSTEM_PROMPT}\n\n# Results\n{context}"
    else:
        system = GUIDE_SYSTEM_PROMPT
    try:
        turns = gemini.sanitize_turns([*req.history[-8:], {"role": "user", "text": req.question}], system)
    except gemini.RequestValidationError as err:
        raise HTTPException(400, str(err)) from err
    try:
        res = gemini.generate(key, gemini.GenerateRequest(turns=turns, system_instruction=system, use_search=True, model=gemini.pick_model(req.model, settings().gemini_model), temperature=0.4))
    except gemini.GeminiError as err:
        return _offline(req, f"_The AI request failed ({err}), so this is the built-in answer._\n\n")
    return {"text": res.text or "No answer was returned.", "sources": res.sources, "suggestions": [], "state": req.state, "engine": "gemini", "model": res.model}


class InterpretRequest(BaseModel):
    toolName: str
    markdown: str = Field(max_length=gemini.MAX_CHARS)
    extraContext: str | None = Field(None, max_length=gemini.MAX_CHARS)
    model: str | None = None


@router.post("/interpret")
def interpret(req: InterpretRequest, request: Request, x_gemini_key: str | None = Header(default=None)) -> dict[str, Any]:
    key = _key(x_gemini_key)
    if not key:
        raise HTTPException(503, "AI is not set up. Add your Gemini API key in Settings, or set GEMINI_API_KEY on the TerraX server.")
    if _rate_limited(request.client.host if request.client else "unknown"):
        raise HTTPException(429, "Too many AI requests. Wait a minute and try again.")
    text = f"{REPORT_PROMPT}\n\nTool: {req.toolName}\n\n{req.extraContext or req.markdown}"
    try:
        res = gemini.generate(key, gemini.GenerateRequest(turns=gemini.sanitize_turns([{"role": "user", "text": text}]), model=gemini.pick_model(req.model, settings().gemini_model), temperature=0.3))
    except gemini.RequestValidationError as err:
        raise HTTPException(400, str(err)) from err
    except gemini.GeminiError as err:
        raise HTTPException(502, str(err)) from err
    if not res.text.strip():
        raise HTTPException(502, "Gemini returned an empty answer. Try again.")
    return res.public()
