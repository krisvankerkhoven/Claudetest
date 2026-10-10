import hashlib, hmac, json
import pytest
from fastapi.testclient import TestClient

from wijnlog import commands, db, import_csv, sync, whatsapp, backup
from wijnlog.sources import lookup
from wijnlog.sources.base import SourceError, WineHit
from wijnlog.sources.generic import _to_hits


@pytest.fixture
def con():
    c = db.connect(":memory:")
    yield c
    c.close()


def fake_lookup(q, vintage=None, limit=5):
    return [WineHit("Chateau Margaux", "Chateau Margaux", vintage or 2015, 4.6, 1200, "123")], "test", []


def no_lookup(q, vintage=None, limit=5):
    return [], "", ["vivino HTTP 403"]


def test_log_then_drunk_and_dedup(con):
    r = commands.handle_text(con, "log Margaux 2015 4,5", fake_lookup)
    assert "Gelogd" in r and "4,5" in r and "—" not in r
    r2 = commands.handle_text(con, "log Margaux 2015 4,5", fake_lookup)
    assert "al gelogd" in r2
    assert con.execute("SELECT COUNT(*) FROM drinks").fetchone()[0] == 1
    out = commands.handle_text(con, "gedronken margaux")
    assert "jouw score 4,5" in out and "Vivino 4,6" in out


def test_log_validation(con):
    assert "tussen 1 en 5" in commands.handle_text(con, "log Margaux 7", fake_lookup)
    assert "score" in commands.handle_text(con, "log Margaux", fake_lookup)


def test_search_shows_history_and_fallback(con):
    commands.handle_text(con, "log Margaux 2015 4", fake_lookup)
    r = commands.handle_text(con, "zoek Chateau Margaux 2015", fake_lookup)
    assert "4,6" in r and "Eerder gedronken" in r
    r = commands.handle_text(con, "zoek Chateau Margaux", no_lookup)
    assert "lukte niet" in r and "Laatst bekende" in r


def test_unknown_wine_logged_anyway(con):
    r = commands.handle_text(con, "log Obscure Cuvee 4", no_lookup)
    assert "Niet herkend" in r
    assert con.execute("SELECT COUNT(*) FROM drinks").fetchone()[0] == 1


def test_help(con):
    assert "zoek" in commands.handle_text(con, "hallo")


def test_source_fallback_chain():
    class Bad:
        name = "bad"
        def search(self, *a): raise SourceError("kapot")
    class Good:
        name = "good"
        def search(self, *a): return [WineHit("X", score=4.0)]
    hits, src, errs = lookup("x", sources=[Bad(), Good()])
    assert src == "good" and errs == ["kapot"]


def test_generic_mapping():
    h = _to_hits([{"wineName": "Foo", "winery": {"name": "Bar"}, "rating": "4,1", "year": "2019", "wineId": 9}])
    assert h[0].producer == "Bar" and h[0].score == 4.1 and h[0].vintage == 2019 and h[0].vivino_id == "9"


def test_csv_import_idempotent(con, tmp_path):
    p = tmp_path / "x.csv"
    p.write_text("Wine name;Winery;Vintage;Your rating;Rating date;Your review\n"
                 "Margaux;Chateau Margaux;2015;4,5;12/03/2024;top\n"
                 "Zonder datum;W;2020;3;;\n", encoding="utf-8")
    assert import_csv.import_file(con, str(p)) == (1, 0, 1)
    assert import_csv.import_file(con, str(p)) == (0, 1, 1)
    assert "4,5" in commands.handle_text(con, "gedronken margaux")


def test_sync_parse_and_store(con):
    items = [{"id": 1, "rating": 4.5, "note": "mooi", "created_at": "2024-05-01T10:00:00.000Z",
              "vintage": {"year": 2019, "statistics": {"ratings_average": 4.2},
                          "wine": {"id": 77, "name": "Cuvee X", "winery": {"name": "Domaine Y"}}}},
             {"rating": None, "vintage": {"wine": {"name": "geen rating"}}}]
    assert sync.store(con, items) == (1, 0)
    assert sync.store(con, items) == (0, 1)
    assert con.execute("SELECT vivino_id FROM wines").fetchone()[0] == "77"


def test_backup(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "w.db"))
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path / "b"))
    with db.session() as c:
        w = db.upsert_wine(c, "A", "B"); db.add_drink(c, w, 2020, "2024-01-01", 4, "", "csv")
    files = backup.run()
    assert all(f.exists() for f in files) and "2024-01-01" in files[1].read_text()


def _post(client, payload, secret="s3", sign=True):
    body = json.dumps(payload).encode()
    h = {"x-hub-signature-256": "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()} if sign else {}
    return client.post("/webhook", content=body, headers=h)


def test_webhook(monkeypatch, tmp_path):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "w.db"))
    monkeypatch.setenv("WA_APP_SECRET", "s3")
    monkeypatch.setenv("WA_VERIFY_TOKEN", "tok")
    monkeypatch.setenv("WA_ALLOWED_NUMBERS", "3247")
    sent = []
    monkeypatch.setattr(whatsapp, "send_text", lambda to, body: sent.append((to, body)))
    from wijnlog import app as appmod
    client = TestClient(appmod.app)
    assert client.get("/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "42"}).text == "42"
    assert client.get("/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "no", "hub.challenge": "42"}).status_code == 403
    mk = lambda frm, mid: {"entry": [{"changes": [{"value": {"messages": [
        {"id": mid, "from": frm, "type": "text", "text": {"body": "hallo"}}]}}]}]}
    assert _post(client, mk("3247", "m1"), sign=False).status_code == 403
    assert _post(client, mk("3247", "m1"), secret="fout").status_code == 403
    assert _post(client, mk("3247", "m1")).status_code == 200
    assert _post(client, mk("3247", "m1")).status_code == 200   # retry: genegeerd
    assert _post(client, mk("9999", "m2")).status_code == 200   # vreemd nummer: genegeerd
    assert len(sent) == 1 and sent[0][0] == "3247"
