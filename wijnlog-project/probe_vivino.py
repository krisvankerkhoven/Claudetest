#!/usr/bin/env python3
"""Stap 0: test welke onofficiële Vivino-endpoints nog werken. Bouwt niets, schrijft niets weg.
Gebruik: cp .env.example .env (invullen), pip install requests, python probe_vivino.py
Print enkel status, content-type en JSON-sleutels. Nooit tokens, cookies of wachtwoorden.
"""
import os, re, sys, json, time
import requests

def load_env(path=".env"):
    if os.path.exists(path):
        for l in open(path):
            if "=" in l and not l.strip().startswith("#"):
                k, v = l.strip().split("=", 1); os.environ.setdefault(k, v)
load_env()
EMAIL, PW, CC = os.getenv("VIVINO_EMAIL"), os.getenv("VIVINO_PASSWORD"), os.getenv("COUNTRY_CODE", "BE")
BASE = "https://www.vivino.com"
S = requests.Session()
S.headers.update({"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                  "Accept": "application/json, text/plain, */*", "Accept-Language": "en"})

def shape(o, depth=0):
    if isinstance(o, dict): return {k: (shape(v, depth+1) if depth < 1 else type(v).__name__) for k, v in list(o.items())[:15]}
    if isinstance(o, list): return [f"list[{len(o)}]", shape(o[0], depth+1)] if o else "list[0]"
    return type(o).__name__

def hit(label, method, url, **kw):
    time.sleep(2)  # beleefd blijven
    try:
        r = S.request(method, url if url.startswith("http") else BASE + url, timeout=25, **kw)
    except Exception as e:
        print(f"[FAIL] {label}: {type(e).__name__}"); return None
    ct = r.headers.get("content-type", "")
    ok = r.status_code == 200 and "json" in ct
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}: HTTP {r.status_code} {ct.split(';')[0]}")
    if "json" in ct:
        try: print("       shape:", json.dumps(shape(r.json()))[:400])
        except Exception: pass
    elif r.status_code in (403, 429) or "captcha" in r.text.lower() or "cloudflare" in r.text.lower():
        print("       bot-bescherming/ratelimit vermoed")
    return r

print("== 1. Zoeken (anoniem)")
q = "chateau margaux 2015"
hit("explore/explore", "GET", "/api/explore/explore", params={"country_code": CC, "q": q, "currency_code": "EUR", "min_rating": 1, "order_by": "ratings_count", "order": "desc", "page": 1, "per_page": 5})
hit("search/wines (html)", "GET", "/search/wines", params={"q": q})
hit("vintages/{id}", "GET", "/api/vintages/1")  # bestaat id 1? enkel om vorm te zien
hit("wines/{id}/reviews", "GET", "/api/wines/1/reviews", params={"per_page": 2})

print("\n== 2. Login")
if not (EMAIL and PW): print("VIVINO_EMAIL/PASSWORD ontbreekt in .env, rest overgeslagen"); sys.exit(0)
home = hit("homepage (csrf)", "GET", "/")
csrf = None
if home is not None:
    m = re.search(r'name="csrf-token"\s+content="([^"]+)"', home.text) or re.search(r'content="([^"]+)"\s+name="csrf-token"', home.text)
    csrf = m.group(1) if m else None
    print("       csrf-token gevonden:", bool(csrf))
h = {"Content-Type": "application/json", "Origin": BASE, "Referer": BASE + "/"}
if csrf: h["X-CSRF-Token"] = csrf
r = hit("POST /api/login", "POST", "/api/login", headers=h, json={"email": EMAIL, "password": PW})
if r is None or r.status_code != 200:
    r = hit("POST /api/sessions", "POST", "/api/sessions", headers=h, json={"email": EMAIL, "password": PW})
user_id = None
if r is not None and "json" in r.headers.get("content-type", ""):
    try:
        j = r.json(); user_id = (j.get("user") or j).get("id")
        print("       user_id gevonden:", bool(user_id))
    except Exception: pass

print("\n== 3. Eigen ratings/activiteit")
if not user_id:
    me = hit("GET /api/users/me", "GET", "/api/users/me", headers=h)
    try: user_id = me.json().get("id")
    except Exception: pass
if not user_id: print("geen user_id, login mislukt of anders gebouwd"); sys.exit(0)
for lbl, path, params in [
    ("users/{id}/reviews", f"/api/users/{user_id}/reviews", {"per_page": 5, "page": 1}),
    ("users/{id}/activity_stream", f"/api/users/{user_id}/activity_stream", {"per_page": 5}),
    ("activities?user_id", "/api/activities", {"user_id": user_id, "per_page": 5}),
    ("users/{id}/wine_list", f"/api/users/{user_id}/wine_list", {"per_page": 5}),
    ("users/{id}/user_vintages", f"/api/users/{user_id}/user_vintages", {"per_page": 5}),
]:
    hit(lbl, "GET", path, headers=h, params=params)
print("\nKlaar. Plak de output hier (bevat geen geheimen). Controleer zelf op e-mailadressen voor je plakt.")
