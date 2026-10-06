"""The tools TerraX runs as jobs. Each takes (ctx, inputs, params) and returns a JSON-able result."""

from __future__ import annotations

from typing import Callable

from .context import ToolContext

Runner = Callable[[ToolContext, dict, dict], dict]
REGISTRY: dict[str, Runner] = {}


def tool(name: str):
    def deco(fn: Runner) -> Runner:
        REGISTRY[name] = fn
        return fn

    return deco


def load_all() -> dict[str, Runner]:
    """Imports the tool modules so they register themselves."""
    from . import forest  # noqa: F401

    for mod in ("raster", "table", "survey", "carbon", "terrain", "landcover", "photo", "residential", "stack"):
        try:
            __import__(f"{__name__}.{mod}")
        except ModuleNotFoundError as err:
            if err.name != f"{__name__}.{mod}":
                raise
    return REGISTRY
