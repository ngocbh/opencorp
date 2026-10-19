"""The built web app, served from app_dir."""

import os

import pytest

from opencorp.hq.static import resolve


async def test_an_asset_is_immutable_and_other_files_are_no_cache(web, dist):
    r = await web.get("/assets/index-abc123.js")
    assert r.status_code == 200 and r.text == "console.log(1)"
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert (await web.get("/theme.js")).headers["cache-control"] == "no-cache"


async def test_a_document_navigation_gets_index_html(web, dist):
    for path in ("/", "/pair", "/people/minh"):
        r = await web.get(path, headers={"sec-fetch-dest": "document"})
        assert r.status_code == 200 and "OpenCorp HQ" in r.text and r.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize(("path", "dest"), [("/assets/gone-123.js", None), ("/assets/gone-123.js", "document"),
                                            ("/gone.css", None), ("/company", "image")])
async def test_a_missing_asset_or_non_document_gets_a_plain_404(web, dist, path, dest):
    r = await web.get(path, headers={"sec-fetch-dest": dest} if dest else {})
    assert r.status_code == 404 and "OpenCorp HQ" not in r.text and r.headers["content-type"].startswith("text/plain")


def test_resolve_refuses_dot_dot_and_symlinks_out_of_app_dir(dist, tmp_path):
    (tmp_path / "secret.txt").write_text("no")
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "x.js").write_text("no")
    os.symlink(tmp_path / "secret.txt", dist / "assets" / "link.js")
    os.symlink(tmp_path / "outside", dist / "assets" / "dir")
    os.symlink(dist / "assets" / "index-abc123.js", dist / "inside.js")
    assert resolve(dist, "assets/../../secret.txt") is None
    assert resolve(dist, "assets/link.js") is None
    assert resolve(dist, "assets/dir/x.js") is None
    assert resolve(dist, str(tmp_path / "secret.txt")) is None
    assert resolve(dist, "assets/index-abc123.js\0") is None
    assert resolve(dist, "assets") is None
    assert resolve(dist, "a" * 5000 + ".js") is None
    assert resolve(dist, "assets/index-abc123.js") == (dist / "assets" / "index-abc123.js").resolve()
    assert resolve(dist, "inside.js") == (dist / "assets" / "index-abc123.js").resolve()


@pytest.mark.parametrize("path", ["/assets/%2e%2e/%2e%2e/secret.txt", "/%2e%2e/secret.txt", "/assets/link.js",
                                  "/assets/%2e%2e%2f%2e%2e%2fsecret.txt"])
async def test_a_request_never_reads_outside_app_dir(web, dist, tmp_path, path):
    (tmp_path / "secret.txt").write_text("the secret")
    os.symlink(tmp_path / "secret.txt", dist / "assets" / "link.js")
    r = await web.get(path)
    assert r.status_code == 404 and "the secret" not in r.text


async def test_without_a_build_a_page_says_how_to_build(web):  # no dist fixture: app_dir doesn't exist
    r = await web.get("/", headers={"sec-fetch-dest": "document"})
    assert r.status_code == 503 and "bun run build" in r.text and "<script" not in r.text
    assert r.headers["content-security-policy"].startswith("default-src 'none'")


async def test_a_dist_without_index_html_is_not_built(web, dist):
    (dist / "index.html").unlink()
    assert (await web.get("/", headers={"sec-fetch-dest": "document"})).status_code == 503
