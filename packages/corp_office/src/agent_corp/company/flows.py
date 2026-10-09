"""Load company flows with child flows confined to the repo."""

import os
from pathlib import Path

import yaml
from yian import ComposedFlow, load_flow


class FlowOutsideRepo(Exception):
    """A flow, or one of its ``uses:`` children, resolves outside the company repo."""


def _declares_system_paths(text: str) -> bool:
    """True if the flow sets ``system.paths``, which a custom child resolver would ignore."""
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError:
        return False  # composer reports the syntax error with a location
    return isinstance(doc, dict) and isinstance(doc.get("system"), dict) and "paths" in doc["system"]


def load_confined(root: Path, path: Path) -> ComposedFlow:
    """Load the flow at ``path``; it and its ``uses:`` children load only from inside ``root``.

    Raises ``FlowOutsideRepo`` for a flow outside ``root``, composer's ``LoadError`` for
    a bad flow, ``OSError`` for an unreadable file, and ``ValueError`` for a reference
    cycle, a pinned-version mismatch, or a flow that sets ``system.paths``.
    """
    return _load(root.resolve(), path, frozenset())


def _load(root: Path, path: Path, loading: frozenset[Path]) -> ComposedFlow:
    """Load one flow under the resolved ``root``; ``loading`` holds its ancestors.

    Composer calls the child resolver as ``resolve(path, version)`` for
    ``<dir>/<path>.yaml``, and re-wraps only its own ``LoadError``, so
    ``FlowOutsideRepo`` reaches the caller unchanged. Composer ignores ``system.paths``
    when a child resolver is given, so such a flow is refused rather than loaded
    differently from ``yian run``.
    """
    # Compare resolved paths so /var -> /private/var on macOS and symlinked roots work.
    path = path.resolve()
    shown = os.path.relpath(path, root)  # messages show repo-relative paths
    if not path.is_relative_to(root):
        raise FlowOutsideRepo(f"{shown} is outside the company repo")
    if path in loading:
        raise ValueError(f"flow-reference cycle at {shown}")
    text = path.read_text(encoding="utf-8")
    if _declares_system_paths(text):
        raise ValueError(f"{shown}: system.paths is not supported in company flows; "
                         "use a relative uses: path")

    def resolve(ref: str, version: str | None = None) -> ComposedFlow:
        child = _load(root, path.parent / f"{ref}.yaml", loading | {path})
        if version is not None and child.version != version:
            raise ValueError(f"{ref} is version {child.version!r}, not {version!r}")
        return child

    return load_flow(text, child_resolver=resolve, source_label=shown)
