"""The built web app, served publicly: it holds no secrets, and /api answers only through the guard."""

from html import escape
from pathlib import Path, PurePosixPath

from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, PlainTextResponse, Response

from opencorp.hq.version import CHECKOUT

IMMUTABLE = "public, max-age=31536000, immutable"
"""The cache policy for ``assets/``, whose names carry a content hash."""

NOT_BUILT = """<!doctype html><html lang="en"><meta charset="utf-8"><title>OpenCorp HQ</title>
<h1>The web app isn't built</h1><p>Run <code>bun run build</code> in the checkout ({checkout}), then reload.</p></html>"""


def resolve(app_dir: Path, rel: str) -> Path | None:
    """The file ``rel`` names under ``app_dir``, or None if there's none or its real path leaves ``app_dir``."""
    if ".." in PurePosixPath(rel).parts or "\0" in rel:
        return None
    try:
        root = app_dir.resolve()
        target = (app_dir / rel).resolve()
        return target if target.is_relative_to(root) and target.is_file() else None
    except (OSError, ValueError):  # a name too long for the file system, for one
        return None


async def serve_app(request: Request) -> Response:
    """A file of the built app; ``index.html`` for a document navigation; a plain 404 for anything else missing."""
    app_dir = request.app.state.hq.config.app_dir
    index = None if app_dir is None else resolve(app_dir, "index.html")
    if index is None:
        return HTMLResponse(NOT_BUILT.format(checkout=escape(str(CHECKOUT))), 503)
    rel = request.path_params["path"]
    found = resolve(app_dir, rel) if rel else None
    if found is not None:
        return FileResponse(found, headers={"cache-control": IMMUTABLE if rel.startswith("assets/") else "no-cache"})
    dest = request.headers.get("sec-fetch-dest")
    if rel.startswith("assets/") or PurePosixPath(rel).suffix or (dest is not None and dest != "document"):
        # Never index.html: a chunk a rebuild deleted must fail as a missing script, so the app checks its version.
        return PlainTextResponse("not found", 404)
    return FileResponse(index, headers={"cache-control": "no-cache"})
