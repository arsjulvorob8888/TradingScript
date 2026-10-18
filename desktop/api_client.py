"""T-Bank Invest REST client. Uses the Windows certificate store so antivirus HTTPS inspection still connects."""
import json
import logging
import socket
import ssl
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from typing import Dict, Optional

from config import TOKEN, USE_SANDBOX, RELIABLE_BONDS, RELIABLE_FUTURES

logger = logging.getLogger(__name__)

try:
    import truststore

    truststore.inject_into_ssl()
except Exception as error:
    logger.warning("Windows certificate store is unavailable: %s", error)

PROD_HOSTS = (
    "https://invest-public-api.tbank.ru/rest",
    "https://invest-public-api.tinkoff.ru/rest",
)
SANDBOX_HOSTS = (
    "https://sandbox-invest-public-api.tbank.ru/rest",
    "https://sandbox-invest-public-api.tinkoff.ru/rest",
)
API = "tinkoff.public.invest.api.contract.v1"
_orig_getaddrinfo = socket.getaddrinfo


@contextmanager
def _force_ipv4():
    """VPN clients often drop IPv6 and the handshake hangs until timeout."""

    def ipv4(host, port, family=0, type=0, proto=0, flags=0):
        return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)

    socket.getaddrinfo = ipv4
    try:
        yield
    finally:
        socket.getaddrinfo = _orig_getaddrinfo


class TBankClient:
    def __init__(self, token: str = TOKEN, sandbox: bool = USE_SANDBOX):
        self.token = self._clean_token(token)
        self.sandbox = sandbox
        self.hosts = SANDBOX_HOSTS if sandbox else PROD_HOSTS
        self._skip_verify = False
        self._auth = "bearer"
        self._use_proxy = False

    @staticmethod
    def _clean_token(token: str) -> str:
        token = (token or "").strip().strip('"').strip("'")
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        return "".join(token.split())

    def _open(self, request, context, use_proxy):
        handlers = []
        if context is not None:
            handlers.append(urllib.request.HTTPSHandler(context=context))
        proxies = urllib.request.getproxies() if use_proxy else {}
        handlers.append(urllib.request.ProxyHandler(proxies))
        opener = urllib.request.build_opener(*handlers)
        with _force_ipv4():
            with opener.open(request, timeout=20) as response:
                raw = response.read().decode()
                return json.loads(raw) if raw else {}

    def _call(self, service: str, method: str, body: Optional[dict] = None) -> dict:
        last_error = None
        contexts = [ssl._create_unverified_context()] if self._skip_verify else [None, ssl._create_unverified_context()]
        if self._use_proxy and urllib.request.getproxies():
            proxy_modes = [True, False]
        elif urllib.request.getproxies():
            proxy_modes = [False, True]
        else:
            proxy_modes = [False]
        for use_proxy in proxy_modes:
            for context in contexts:
                for host in self.hosts:
                    url = f"{host}/{API}.{service}/{method}"
                    request = urllib.request.Request(
                        url,
                        data=json.dumps(body or {}).encode(),
                        method="POST",
                        headers={
                            "Authorization": self.token if self._auth == "raw" else f"Bearer {self.token}",
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                        },
                    )
                    try:
                        payload = self._open(request, context, use_proxy)
                        self._use_proxy = use_proxy
                        if context is not None:
                            self._skip_verify = True
                        return payload
                    except urllib.error.HTTPError as error:
                        if context is not None:
                            self._skip_verify = True
                        self._use_proxy = use_proxy
                        detail = error.read().decode(errors="replace")[:400]
                        raise RuntimeError(f"T-Bank {error.code}: {detail}") from error
                    except Exception as error:
                        last_error = error
                        time.sleep(0.3)
        raise RuntimeError(
            "Нет связи с API Т-Банка через VPN и напрямую. "
            "Разрешите в VPN адреса invest-public-api.tbank.ru и invest-public-api.tinkoff.ru. "
            + str(last_error)
        )

    def get_accounts(self):
        if not self.token or self.token == "YOUR_TOKEN_HERE":
            raise RuntimeError("Вставьте токен из Т-Инвестиции: Настройки, Токен для T-Invest API.")
        order = [False, True] if not self.sandbox else [True, False]
        last_error = None
        for sandbox in order:
            self.sandbox = sandbox
            self.hosts = SANDBOX_HOSTS if sandbox else PROD_HOSTS
            service, method = (
                ("SandboxService", "GetSandboxAccounts") if sandbox else ("UsersService", "GetAccounts")
            )
            for auth in ("bearer", "raw"):
                self._auth = auth
                try:
                    payload = self._call(service, method)
                    accounts = payload.get("accounts") or []
                    if sandbox and not accounts:
                        self._call("SandboxService", "OpenSandboxAccount", {})
                        payload = self._call(service, method)
                        accounts = payload.get("accounts") or []
                    return accounts
                except RuntimeError as error:
                    last_error = error
                    text = str(error)
                    if "40003" in text or "401" in text:
                        continue
                    if "Нет связи" in text:
                        continue
                    raise
        raise RuntimeError(
            "Токен не принят ни боевым счётом, ни песочницей. "
            "Выпустите новый в приложении Т-Инвестиции: профиль, Настройки, Токен для API. "
            "Скопируйте его целиком, без слова Bearer и без пробелов. "
            f"Ответ банка: {last_error}"
        )

    def get_portfolio(self, account_id: str):
        service = "SandboxService" if self.sandbox else "OperationsService"
        method = "GetSandboxPortfolio" if self.sandbox else "GetPortfolio"
        return self._call(service, method, {"accountId": account_id})

    def find_instrument(self, query: str):
        return self._call("InstrumentsService", "FindInstrument", {"query": query})

    def get_bond_info(self, figi: str):
        return self._call(
            "InstrumentsService",
            "BondBy",
            {"idType": "INSTRUMENT_ID_TYPE_FIGI", "id": figi},
        )

    def get_future_info(self, figi: str):
        return self._call(
            "InstrumentsService",
            "FutureBy",
            {"idType": "INSTRUMENT_ID_TYPE_FIGI", "id": figi},
        )

    def get_last_price(self, figi: str):
        payload = self._call("MarketDataService", "GetLastPrices", {"figi": [figi]})
        prices = payload.get("lastPrices") or payload.get("last_prices") or []
        if not prices:
            return None
        return prices[0].get("price")

    def get_bond_coupons(self, figi: str):
        return self._call(
            "InstrumentsService",
            "GetBondCoupons",
            {"figi": figi, "from": "2020-01-01T00:00:00Z", "to": "2035-01-01T00:00:00Z"},
        )

    def place_order(self, account_id: str, figi: str, quantity: int, direction: str, order_type: str = "LIMIT", price: float = None):
        body = {
            "figi": figi,
            "quantity": str(quantity),
            "direction": "ORDER_DIRECTION_BUY" if direction == "BUY" else "ORDER_DIRECTION_SELL",
            "accountId": account_id,
            "orderType": "ORDER_TYPE_LIMIT" if order_type == "LIMIT" else "ORDER_TYPE_MARKET",
        }
        if price is not None and order_type == "LIMIT":
            units = int(price)
            nano = int(round((price - units) * 1_000_000_000))
            body["price"] = {"units": str(units), "nano": nano}
        if self.sandbox:
            return self._call("SandboxService", "PostSandboxOrder", body)
        return self._call("OrdersService", "PostOrder", body)

    def get_reliable_instruments(self) -> Dict:
        return {"bonds": dict(RELIABLE_BONDS), "futures": dict(RELIABLE_FUTURES)}
