"""Funding, money-market yields and the loan-rate target."""
import json
import ssl
import urllib.request

YEAR_FUNDING = {
    "USDRUBF": {"2023": -0.7, "2024": 7.1, "2025": 22.3, "2026": 9.8},
    "CNYRUBF": {"2023": 5.5, "2024": 1.2, "2025": 18.9, "2026": 6.9},
}
MONTHLY_2026 = {
    "USDRUBF": [("Янв", 30), ("Фев", 11), ("Мар", -4), ("Апр", 23), ("Май", 19), ("Июн", 22), ("Июл", 3), ("Авг", 2)],
    "CNYRUBF": [("Янв", 13), ("Фев", 9), ("Мар", -5), ("Апр", 12), ("Май", 14), ("Июн", 12), ("Июл", 9), ("Авг", 7)],
}
PRICE_PATH = {
    "USDRUBF": {"2023": (71.1, 90.1), "2024": (91.9, 101.7), "2025": (101.7, 78.2), "2026": (78.2, 83.6)},
    "CNYRUBF": {"2023": (10.1, 12.6), "2024": (12.7, 13.7), "2025": (13.8, 11.2), "2026": (11.4, 12.5)},
}
BOND_CANDIDATES = [
    {"isin": "RU000A10AXW4", "name": "СИБУР 001Р-03", "currency": "USD", "ytm": 9.32, "price": 101.1, "coupon": 9.6, "maturity": "2028-08-02", "note": "короткая, ликвидная"},
    {"isin": "RU000A10B7J8", "name": "ФосАгро 2П3", "currency": "USD", "ytm": 8.99, "price": 99.0, "coupon": 7.5, "maturity": "2027-09-18", "note": "мало сделок"},
    {"isin": "RU000A10BPP2", "name": "Газпром капитал 3Р14", "currency": "USD", "ytm": 10.09, "price": 94.6, "coupon": 7.25, "maturity": "2029-05-08", "note": "дисконт"},
    {"isin": "RU000A10F108", "name": "Акрон Б2P3", "currency": "CNY", "ytm": 9.68, "price": 96.6, "coupon": 7.85, "maturity": "2029-10-11", "note": "лучший юань"},
    {"isin": "RU000A10FGV0", "name": "Полюс Б1P11", "currency": "CNY", "ytm": 9.17, "price": 96.2, "coupon": 7.8, "maturity": "2033-05-17", "note": "длинная"},
    {"isin": "RU000A105112", "name": "РУСАЛ БО-06", "currency": "CNY", "ytm": 7.41, "price": 100.7, "coupon": 8.25, "maturity": "2027-07-28", "note": "премия к номиналу"},
]

def two_year_average(ticker):
    book = YEAR_FUNDING[ticker]
    return (book["2024"] + book["2025"]) / 2

def monthly_average(ticker):
    values = [value for _, value in MONTHLY_2026[ticker]]
    return sum(values) / len(values)

def _last_print(ticker):
    ctx = ssl._create_unverified_context()
    url = (
        "https://iss.moex.com/iss/history/engines/futures/markets/forts/securities/"
        f"{ticker}.json?from=2026-10-01&iss.meta=off&limit=30"
        "&history.columns=TRADEDATE,SETTLEPRICE,SWAPRATE"
    )
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=8, context=ctx) as response:
        rows = [row for row in json.loads(response.read().decode())["history"]["data"] if row[1]]
    if not rows:
        return None
    fresh = next((row for row in reversed(rows) if row[2]), rows[-1])
    return {"price": rows[-1][1], "price_date": rows[-1][0], "funding": (fresh[2] / fresh[1]) * 365 * 100, "funding_date": fresh[0]}

def snapshot(live=False):
    fresh = {ticker: None for ticker in ("USDRUBF", "CNYRUBF")}
    if live:
        for ticker in fresh:
            try:
                fresh[ticker] = _last_print(ticker)
            except Exception:
                fresh[ticker] = None
    return {
        "year": YEAR_FUNDING, "monthly": MONTHLY_2026, "path": PRICE_PATH,
        "two_year": {ticker: two_year_average(ticker) for ticker in YEAR_FUNDING},
        "month_avg": {ticker: monthly_average(ticker) for ticker in MONTHLY_2026},
        "live": fresh, "bonds": BOND_CANDIDATES,
    }

# Snapshot 16 October 2026, used when the exchange does not answer.
FALLBACK = {
    "lqdt": 13.53,
    "tmon": 12.93,
    "ofz": 13.24,
    "ofz_name": "ОФЗ 26232, погашение октябрь 2027",
    "usd_funding": 5.0,
    "cny_funding": 8.6,
    "usd_ytm": 9.32,
    "usd_price": 101.1,
    "cny_ytm": 9.68,
    "cny_price": 96.6,
    "asof": "16 октября 2026",
}

# Loan rates are full cost or the bank's published range, not the advertising floor alone.
CREDIT_RATES = [
    ("Ключевая ставка ЦБ", 14.00, "начало октября 2026, заседание 23 октября"),
    ("Вклады топ-10 банков, максимум", 13.06, "Банк России, I декада октября"),
    ("Кредиты онлайн на Финуслугах", 19.95, "8–15 октября"),
    ("Сбер, наличные, нижняя ставка", 21.40, "диапазон 21,4–49,9%, ПСК от 17,4%, на 16 октября"),
    ("ВТБ, наличные, ПСК от", 19.90, "ПСК 19,9–55,4% на 5 октября"),
    ("Альфа-Банк, наличные, ПСК от", 18.99, "ориентир 19–52%"),
    ("Т-Банк, средняя ПСК без залога", 29.89, "Финуслуги, середина октября"),
    ("Газпромбанк, залоговый ПСК", 23.12, "средняя по залоговым кредитам"),
    ("Индекс ПСК наличных, топ-20", 30.12, "Финуслуги, 15 октября"),
    ("Средняя ПСК без залога", 34.38, "Финуслуги, 15 октября"),
]


def _history_close(ticker: str):
    ctx = ssl._create_unverified_context()
    url = (
        "https://iss.moex.com/iss/history/engines/stock/markets/shares/boards/TQBR/securities/"
        f"{ticker}.json?from=2026-09-01&iss.meta=off&history.columns=TRADEDATE,CLOSE,LEGALCLOSEPRICE"
    )
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=12, context=ctx) as response:
        rows = json.loads(response.read().decode())["history"]["data"]
    clean = []
    for date, close, legal in rows:
        price = legal or close
        if price:
            clean.append((date, float(price)))
    return clean


def _annualized(clean, points: int) -> float:
    if len(clean) < 2:
        return None
    sample = clean[-(points + 1):]
    start, end = sample[0], sample[-1]
    from datetime import datetime
    days = max((datetime.fromisoformat(end[0]) - datetime.fromisoformat(start[0])).days, 1)
    return (end[1] / start[1] - 1) * 365 / days * 100


def _bond_yield(secid: str):
    ctx = ssl._create_unverified_context()
    url = (
        "https://iss.moex.com/iss/engines/stock/markets/bonds/securities/"
        f"{secid}.json?iss.meta=off&marketdata.columns=BOARDID,LAST,YIELD"
    )
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=12, context=ctx) as response:
        payload = json.loads(response.read().decode())["marketdata"]
    for row in payload["data"]:
        rec = dict(zip(payload["columns"], row))
        if rec.get("BOARDID") in ("TQOB", "TQCB") and rec.get("YIELD"):
            return float(rec["YIELD"]), float(rec["LAST"] or 0)
    return None


def live_market():
    """Current yields. Missing fields fall back to the 16 October snapshot."""
    out = dict(FALLBACK)
    out["source"] = "снимок 16 октября 2026"
    try:
        lqdt = _history_close("LQDT")
        tmon = _history_close("TMON")
        if lqdt:
            out["lqdt"] = _annualized(lqdt, 10)
            out["lqdt_45"] = _annualized(lqdt, 30)
        if tmon:
            out["tmon"] = _annualized(tmon, 10)
            out["tmon_45"] = _annualized(tmon, 30)
        out["source"] = "Мосбиржа, последние 10 сессий"
    except Exception:
        out["lqdt_45"] = 14.43
        out["tmon_45"] = 13.44
    else:
        out.setdefault("lqdt_45", 14.43)
        out.setdefault("tmon_45", 13.44)
    for ticker, key in (("USDRUBF", "usd"), ("CNYRUBF", "cny")):
        try:
            fresh = _last_print(ticker)
            if fresh:
                out[f"{key}_funding"] = fresh["funding"]
                out[f"{key}_price_fx"] = fresh["price"]
        except Exception:
            pass
    try:
        ytm, price = _bond_yield("SU26232RMFS7")
        if ytm:
            out["ofz"] = ytm
    except Exception:
        pass
    try:
        ytm, price = _bond_yield("RU000A10AXW4")
        if ytm:
            out["usd_ytm"] = ytm
            if price:
                out["usd_price"] = price
    except Exception:
        pass
    try:
        ytm, price = _bond_yield("RU000A10F108")
        if ytm:
            out["cny_ytm"] = ytm
            if price:
                out["cny_price"] = price
    except Exception:
        pass
    return out
