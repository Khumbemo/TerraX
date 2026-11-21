"""Assistant endpoints: the built-in assistant and AI from any provider's key (agents/llm.py).

Keys come from the user's browser in ``X-AI-Credentials`` (up to three, in order; ``X-Gemini-Key`` from older
clients is still read) and from the server (TERRAX_AI_KEY, or GEMINI_API_KEY). ``POST /api/agents/chat`` asks them in
that order, skipping a key that is over its limit or fails, and falls back to the built-in assistant, so a question
is always answered. Each key has its own limit per minute (TERRAX_AI_PER_KEY_PER_MINUTE), on top of 20 a minute per
client, and a key the provider has rate-limited rests for the provider's Retry-After. ``POST /api/agents/detect``
recognises a key's provider and lists its models. The server keeps no chat history and never stores keys.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .. import auth, ratelimit
from ..agents import assistant, gemini, llm
from ..agents.prompts import DATA_SYSTEM_PROMPT, GUIDE_SYSTEM_PROMPT, REPORT_PROMPT
from ..auth import Principal
from ..config import settings

router = APIRouter(prefix="/api/agents", tags=["agents"])


def _client_ip(request: Request) -> str:
    return auth.client_ip(request)


def _chain(x_ai_credentials: str | None, x_gemini_key: str | None, model: str | None) -> tuple[list[llm.Credential], str]:
    """The keys to try, in order: the browser's, then the server's (unless it is the same key). A browser key that
    cannot be read is left out, and the second value says why, so the server's key or the built-in assistant still answer."""
    problem = ""
    creds: list[llm.Credential] = []
    try:
        creds = llm.parse_credentials(x_ai_credentials)
        if not creds and (x_gemini_key or "").strip():  # clients from before any-provider keys
            creds = [llm.make_credential(x_gemini_key, "gemini", gemini.pick_model(model, settings().gemini_model))]
    except llm.LLMError as err:
        problem = f"Your AI key could not be used: {err}"
    server = llm.server_credential()
    if server and all(c.fingerprint != server.fingerprint for c in creds):
        if server.provider == "gemini" and model and not x_ai_credentials:  # older clients chose the server's Gemini model
            server = replace(server, model=gemini.pick_model(model, server.model))
        creds.append(server)
    return creds, problem


def _per_key(cred: llm.Credential) -> tuple[bool, int]:
    """Each key's own budget. The server's key is shared by every user, so it has its own setting (no cap by default)."""
    if cred.source == "server":
        return ratelimit.allow("ai_server", cred.fingerprint) if settings().ai_server_per_minute else (True, 0)
    return ratelimit.allow("ai_key", cred.fingerprint)


@router.get("/status")
def status() -> dict[str, Any]:
    return llm.server_status()


class DetectRequest(BaseModel):
    provider: str = Field("auto", max_length=40)
    baseUrl: str | None = Field(None, max_length=300)
    model: str | None = Field(None, max_length=128)


_DETECT_STATUS = {"bad": 400, "config": 400, "auth": 422, "model": 422, "rate": 429, "network": 502, "server": 502}


@router.post("/detect")
def detect(body: DetectRequest, request: Request, x_ai_key: str | None = Header(default=None)) -> dict[str, Any]:
    """Recognises the key's provider (or checks the one chosen) by listing its models: free, no tokens spent."""
    ok, retry = ratelimit.allow("ai_detect", _client_ip(request))
    if not ok:
        raise HTTPException(429, f"Too many key checks. Try again in {retry} s.", headers={"Retry-After": str(retry)})
    try:
        return llm.detect(x_ai_key, body.provider, body.baseUrl, body.model).public()
    except llm.LLMError as err:
        raise HTTPException(_DETECT_STATUS.get(err.kind, 502), str(err)) from err


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


def _table_for(results: Results | None, p: Principal | None):
    if not results or not results.fileId or p is None:
        return None
    from .. import storage
    from ..processing.table import read_table

    try:
        auth.own_file(p, results.fileId)
        f = storage.get_file(results.fileId)
    except KeyError:
        return None
    return read_table(f.path, f.name) if f.kind == "table" else None


def _offline(req: ChatRequest, note: str = "", p: Principal | None = None) -> dict[str, Any]:
    ctx = assistant.Context(
        target_lat=req.target.lat,
        target_lon=req.target.lon,
        target_name=req.target.name,
        operator=req.operator,
        now=req.now or datetime.now(UTC),
        tz_offset_min=req.tzOffsetMinutes,
        results=req.results.model_dump() if req.results else None,
        table=_table_for(req.results, p) if req.agent == "results" else None,
    )
    r, state = assistant.reply(req.question, ctx, req.agent, req.state)
    return {"text": note + r["text"], "suggestions": r["suggestions"], "sources": [], "state": state, "engine": "built-in"}


@router.post("/chat")
def chat(req: ChatRequest, request: Request, x_ai_credentials: str | None = Header(default=None),
         x_gemini_key: str | None = Header(default=None)) -> dict[str, Any]:
    p = request.state.principal
    if not req.useAi:
        return _offline(req, p=p)
    chain, problem = _chain(x_ai_credentials, x_gemini_key, req.model)
    if not chain:
        return _offline(req, f"_{problem} This is the built-in answer._\n\n" if problem else "", p=p)
    ok, _ = ratelimit.allow("ai", _client_ip(request))
    if not ok:
        return _offline(req, "_Too many AI requests in the last minute, so this is the built-in answer._\n\n", p=p)
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
    ask = gemini.GenerateRequest(turns=turns, system_instruction=system, use_search=True, model="", temperature=0.4)
    try:
        res, cred, notes = llm.ask(chain, ask, _per_key)
    except llm.LLMError as err:
        first = f"{problem} " if problem else ""
        return _offline(req, f"_{first}The AI request failed ({err}), so this is the built-in answer._\n\n", p=p)
    skipped = ([problem] if problem else []) + notes
    note = f"_{skipped[0]} Answered with {cred.spec.name}._\n\n" if skipped else ""
    return {"text": note + (res.text or "No answer was returned."), "sources": res.sources, "suggestions": [], "state": req.state,
            "engine": cred.provider, "providerName": cred.spec.name, "model": res.model}


class InterpretRequest(BaseModel):
    toolName: str
    markdown: str = Field(max_length=gemini.MAX_CHARS)
    extraContext: str | None = Field(None, max_length=gemini.MAX_CHARS)
    model: str | None = None


@router.post("/interpret")
def interpret(req: InterpretRequest, request: Request, x_ai_credentials: str | None = Header(default=None),
              x_gemini_key: str | None = Header(default=None)) -> dict[str, Any]:
    chain, problem = _chain(x_ai_credentials, x_gemini_key, req.model)
    if problem and not chain:
        raise HTTPException(400, problem)
    if not chain:
        raise HTTPException(503, "AI is not set up. Add an API key from any AI provider in Settings, or set TERRAX_AI_KEY on the TerraX server.")
    ok, retry = ratelimit.allow("ai", _client_ip(request))
    if not ok:
        raise HTTPException(429, f"Too many AI requests. Try again in {retry} s.", headers={"Retry-After": str(retry)})
    text = f"{REPORT_PROMPT}\n\nTool: {req.toolName}\n\n{req.extraContext or req.markdown}"
    try:
        turns = gemini.sanitize_turns([{"role": "user", "text": text}])
    except gemini.RequestValidationError as err:
        raise HTTPException(400, str(err)) from err
    try:
        res, cred, _ = llm.ask(chain, gemini.GenerateRequest(turns=turns, model="", temperature=0.3), _per_key)
    except llm.LLMError as err:
        if err.kind == "rate":
            wait = str(int(err.retry_after or 60))
            raise HTTPException(429, str(err), headers={"Retry-After": wait}) from err
        raise HTTPException(502, str(err)) from err
    if not res.text.strip():
        raise HTTPException(502, f"{cred.spec.name} returned an empty answer. Try again.")
    return {**res.public(), "provider": cred.provider, "providerName": cred.spec.name}
