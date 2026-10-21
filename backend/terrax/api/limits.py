"""Request body limits, enforced while the body arrives.

Uploads (POST /api/files) may be up to TERRAX_MAX_UPLOAD_MB (plus a little multipart overhead); every other request
body up to TERRAX_MAX_BODY_MB. A declared Content-Length over the limit is refused at once; a body sent without one
(chunked) is counted as it streams and cut off at the limit, before the framework buffers it into memory or spools it
to disk.
"""

from __future__ import annotations

import json

from ..config import settings

MULTIPART_SLACK = 1024 * 1024  # boundaries and part headers around the file


class BodyTooLarge(BaseException):
    """Raised from receive() past the limit. A BaseException (like asyncio's CancelledError), so the framework's
    handlers for broken bodies (FastAPI answers 400 for any Exception while parsing JSON) let it through."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"The request body is larger than {limit // (1024 * 1024)} MB.")
        self.limit = limit


def limit_for(method: str, path: str) -> int:
    s = settings()
    if method == "POST" and path.rstrip("/") == "/api/files":
        return s.max_upload + MULTIPART_SLACK
    return s.max_body


class BodyLimitMiddleware:
    """Pure ASGI middleware (outermost), so the limit holds for every route and for streamed bodies."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        limit = limit_for(scope["method"], scope["path"])
        declared = next((v for k, v in scope.get("headers", []) if k == b"content-length"), None)
        if declared is not None:
            try:
                if int(declared) > limit:
                    return await _too_large(send, limit)
            except ValueError:
                return await _respond(send, 400, "The Content-Length header is not a number.")
        seen = 0
        started = False

        async def counted_receive():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise BodyTooLarge(limit)
            return message

        async def tracking_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counted_receive, tracking_send)
        except BodyTooLarge:
            if not started:
                await _too_large(send, limit)
        except BaseExceptionGroup as eg:  # anyio task groups (BaseHTTPMiddleware) may wrap it
            if eg.subgroup(BodyTooLarge) is None:
                raise
            if not started:
                await _too_large(send, limit)


async def _too_large(send, limit: int) -> None:
    await _respond(send, 413, f"The request is larger than the {limit // (1024 * 1024)} MB this server accepts.")


async def _respond(send, status: int, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode()
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), (b"connection", b"close")]})
    await send({"type": "http.response.body", "body": body})
