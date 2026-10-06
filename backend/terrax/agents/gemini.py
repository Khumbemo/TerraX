"""Gemini calls for the assistants and report interpretation (google-genai SDK).

The key comes from the server's GEMINI_API_KEY, or from the user's own key
sent with the request (never stored on the server).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

DEFAULT_MODEL = "gemini-2.5-flash"
MAX_TURNS = 30
MAX_CHARS = 150_000
MODEL_PATTERN = re.compile(r"^gemini-[a-z0-9.\-]+$", re.I)


class RequestValidationError(ValueError):
    pass


@dataclass
class GenerateRequest:
    turns: list[dict[str, str]]
    system_instruction: str | None = None
    use_search: bool = False
    model: str = DEFAULT_MODEL
    temperature: float = 0.4


@dataclass
class GenerateResult:
    text: str
    model: str
    sources: list[dict[str, str]] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {"text": self.text, "sources": self.sources, "model": self.model}


def pick_model(value: Any, default: str = DEFAULT_MODEL) -> str:
    return value if isinstance(value, str) and MODEL_PATTERN.match(value) else default


def sanitize_turns(turns: Any, system_instruction: str | None = None) -> list[dict[str, str]]:
    """Validates untrusted chat turns. Raises RequestValidationError."""
    if not isinstance(turns, list) or not turns:
        raise RequestValidationError('"turns" must be a non-empty array.')
    out = []
    for i, t in enumerate(turns[-MAX_TURNS:]):
        if not isinstance(t, dict) or t.get("role") not in ("user", "model") or not isinstance(t.get("text"), str):
            raise RequestValidationError(f'Turn {i} must have role "user" or "model" and a text string.')
        out.append({"role": t["role"], "text": t["text"]})
    if out[-1]["role"] != "user":
        raise RequestValidationError("The last turn must come from the user.")
    total = sum(len(t["text"]) for t in out) + len(system_instruction or "")
    if total > MAX_CHARS:
        raise RequestValidationError(f"Request is too large ({total} characters, limit {MAX_CHARS}).")
    return out


def describe_error(err: BaseException | str) -> str:
    """Turns an SDK/API error into a message a user can act on."""
    raw = str(err)
    message = raw
    try:
        parsed = json.loads(raw)
        message = parsed.get("error", {}).get("message") or raw
    except (ValueError, AttributeError):
        pass
    if re.search(r"429|RESOURCE_EXHAUSTED|quota", raw, re.I):
        return "The Gemini API rate limit or quota was reached. Wait a minute, or check the quota for your API key."
    if re.search(r"API key not valid|API_KEY_INVALID|401|403|PERMISSION_DENIED", raw, re.I):
        return "The Gemini API rejected the API key. Check that the key is correct and has the Generative Language API enabled."
    if re.search(r"404|NOT_FOUND|is not found", raw, re.I):
        return "The selected Gemini model is not available for this key. Choose another model in Settings."
    return f"Gemini request failed: {message}"


class GeminiError(RuntimeError):
    pass


def generate(api_key: str, req: GenerateRequest) -> GenerateResult:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        system_instruction=req.system_instruction,
        temperature=req.temperature,
        tools=[types.Tool(google_search=types.GoogleSearch())] if req.use_search else None,
    )
    contents = [types.Content(role=t["role"], parts=[types.Part(text=t["text"])]) for t in req.turns]
    try:
        response = client.models.generate_content(model=req.model, contents=contents, config=config)
    except Exception as err:  # noqa: BLE001 — every SDK failure becomes a readable message
        raise GeminiError(describe_error(err)) from err

    sources: list[dict[str, str]] = []
    seen: set[str] = set()
    cands = response.candidates or []
    meta = cands[0].grounding_metadata if cands else None
    for chunk in (meta.grounding_chunks if meta and meta.grounding_chunks else []) or []:
        web = chunk.web
        uri = web.uri if web else None
        if uri and uri not in seen:
            seen.add(uri)
            sources.append({"uri": uri, "title": (web.title if web and web.title else urlparse(uri).hostname or uri)})
    return GenerateResult(text=response.text or "", sources=sources, model=req.model)
