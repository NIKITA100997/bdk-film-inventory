from app.main import resolve_static_path


def _make_build(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>spa</html>")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)")
    (dist / "favicon.svg").write_text("<svg/>")
    return dist


class TestResolveStaticPath:
    """Раздел про раздачу production-сборки фронтенда backend'ом (быстрый
    режим для планшетов) — путь до файла ищется только внутри dist/,
    "../"-запросы не должны выйти за её пределы."""

    def test_finds_real_asset_file(self, tmp_path):
        dist = _make_build(tmp_path)
        found = resolve_static_path(dist, "assets/index-abc123.js")
        assert found == dist / "assets" / "index-abc123.js"

    def test_finds_root_level_file(self, tmp_path):
        dist = _make_build(tmp_path)
        assert resolve_static_path(dist, "favicon.svg") == dist / "favicon.svg"

    def test_missing_file_returns_none(self, tmp_path):
        dist = _make_build(tmp_path)
        assert resolve_static_path(dist, "assets/does-not-exist.js") is None

    def test_empty_path_returns_none(self, tmp_path):
        dist = _make_build(tmp_path)
        assert resolve_static_path(dist, "") is None

    def test_traversal_outside_dist_is_rejected(self, tmp_path):
        dist = _make_build(tmp_path)
        secret = tmp_path / "secret.txt"
        secret.write_text("не должно быть видно")
        found = resolve_static_path(dist, "../secret.txt")
        assert found is None

    def test_deep_traversal_is_rejected(self, tmp_path):
        dist = _make_build(tmp_path)
        found = resolve_static_path(dist, "../../../../etc/passwd")
        assert found is None

    def test_does_not_match_directory(self, tmp_path):
        dist = _make_build(tmp_path)
        # "assets" сам по себе — директория, не файл; не должен считаться
        # найденным, иначе FileResponse упадёт при попытке его открыть.
        assert resolve_static_path(dist, "assets") is None
