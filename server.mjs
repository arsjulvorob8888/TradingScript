import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setDefaultResultOrder } from "node:dns";
import { listBonds } from "./bonds.mjs";

setDefaultResultOrder("ipv4first");

const API = "tinkoff.public.invest.api.contract.v1";
const SANDBOX = ["https://sandbox-invest-public-api.tbank.ru/rest", "https://sandbox-invest-public-api.tinkoff.ru/rest"];
const PROD = ["https://invest-public-api.tbank.ru/rest", "https://invest-public-api.tinkoff.ru/rest"];
const ROOT = dirname(fileURLToPath(import.meta.url));
const KEY_RATE = 14;
const FALLBACK = { lqdt: 13.53, tmon: 12.93, ofz: 13.24, usdFunding: 5, cnyFunding: 8.6, usdYtm: 9.32, usdPrice: 101.1, cnyYtm: 9.68, cnyPrice: 96.6 };

function http(url, method, headers, body = "") {
  const once = (secure) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpsRequest({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      rejectUnauthorized: secure,
      family: 4,
      timeout: 12000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
  return once(true).catch(() => once(false));
}

async function jsonGet(url) {
  const result = await http(url, "GET", { "User-Agent": "Mozilla/5.0" });
  return JSON.parse(result.text);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function netCarry(ytm, funding, price) {
  const tax = 0.87;
  const numerator = tax * (ytm / 100) * (price / 100) + tax * (funding / 100) - 0.005;
  return (numerator / (price / 100 + 0.1)) * 100;
}

async function annualized(ticker) {
  const payload = await jsonGet(`https://iss.moex.com/iss/history/engines/stock/markets/shares/boards/TQBR/securities/${ticker}.json?from=2026-09-01&iss.meta=off&history.columns=TRADEDATE,CLOSE,LEGALCLOSEPRICE`);
  const rows = (payload.history?.data || []).map((row) => ({ date: row[0], price: Number(row[2] || row[1]) })).filter((row) => row.price);
  if (rows.length < 2) return null;
  const sample = rows.slice(-11);
  const days = Math.max((Date.parse(sample.at(-1).date) - Date.parse(sample[0].date)) / 86_400_000, 1);
  return (sample.at(-1).price / sample[0].price - 1) * (365 / days) * 100;
}

async function funding(ticker) {
  const payload = await jsonGet(`https://iss.moex.com/iss/history/engines/futures/markets/forts/securities/${ticker}.json?from=2026-10-01&iss.meta=off&history.columns=TRADEDATE,SETTLEPRICE,SWAPRATE`);
  const fresh = [...(payload.history?.data || [])].reverse().find((row) => row[1] && row[2]);
  return fresh ? (fresh[2] / fresh[1]) * 365 * 100 : null;
}

async function bondYield(secid) {
  const payload = await jsonGet(`https://iss.moex.com/iss/engines/stock/markets/bonds/securities/${secid}.json?iss.meta=off&marketdata.columns=BOARDID,YIELD`);
  const columns = payload.marketdata?.columns || [];
  for (const row of payload.marketdata?.data || []) {
    const record = Object.fromEntries(columns.map((name, index) => [name, row[index]]));
    if ((record.BOARDID === "TQOB" || record.BOARDID === "TQCB") && record.YIELD) return Number(record.YIELD);
  }
  return null;
}

async function market() {
  const data = { ...FALLBACK };
  try {
    const [lqdt, tmon, usd, cny, ofz] = await Promise.all([
      annualized("LQDT"), annualized("TMON"), funding("USDRUBF"), funding("CNYRUBF"), bondYield("SU26232RMFS7"),
    ]);
    if (lqdt) data.lqdt = lqdt;
    if (tmon) data.tmon = tmon;
    if (usd != null) data.usdFunding = usd;
    if (cny != null) data.cnyFunding = cny;
    if (ofz) data.ofz = ofz;
    return { data, source: "Мосбиржа, последние сессии" };
  } catch {
    return { data, source: "снимок 16 октября 2026" };
  }
}

function planFrom(marketData) {
  const usd = netCarry(marketData.usdYtm, marketData.usdFunding, marketData.usdPrice);
  const cny = netCarry(marketData.cnyYtm, marketData.cnyFunding, marketData.cnyPrice);
  const hurdle = Math.max(marketData.lqdt, marketData.tmon);
  const weights = { usd: 0.4, cny: 0.2, rub: 0.25, lqdt: 0.1, tmon: 0.05 };
  for (const key of ["usd", "cny"]) {
    if ((key === "usd" ? usd : cny) < hurdle) {
      const cut = weights[key] * 0.5;
      weights[key] -= cut;
      weights.rub += cut * 0.6;
      weights.lqdt += cut * 0.4;
    }
  }
  const forecast = weights.usd * usd + weights.cny * cny + weights.rub * marketData.ofz + weights.lqdt * marketData.lqdt + weights.tmon * marketData.tmon;
  return {
    forecast: round1(forecast),
    yields: { usd: round1(usd), cny: round1(cny), ofz: round1(marketData.ofz), lqdt: round1(marketData.lqdt), tmon: round1(marketData.tmon) },
    plan: [
      { name: "Пара доллар", group: "Пары", share: Math.round(weights.usd * 100), yield: round1(usd) },
      { name: "Пара юань", group: "Пары", share: Math.round(weights.cny * 100), yield: round1(cny) },
      { name: "ОФЗ 26232", group: "Облигации", share: Math.round(weights.rub * 100), yield: round1(marketData.ofz) },
      { name: "LQDT", group: "Фонды", share: Math.round(weights.lqdt * 100), yield: round1(marketData.lqdt) },
      { name: "TMON", group: "Фонды", share: Math.round(weights.tmon * 100), yield: round1(marketData.tmon) },
    ],
  };
}

function money(value) {
  if (!value || typeof value !== "object") return Number(value) || 0;
  return Number(value.units || 0) + Number(value.nano || 0) / 1e9;
}

async function tbank(token, host, service, method, body) {
  const result = await http(`${host}/${API}.${service}/${method}`, "POST", {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }, JSON.stringify(body));
  if (result.status < 200 || result.status >= 300) throw new Error(`T-Bank ${result.status}: ${result.text.slice(0, 180)}`);
  return JSON.parse(result.text);
}

async function contour(token) {
  let last = "нет ответа";
  for (const item of [{ hosts: SANDBOX, sandbox: true }, { hosts: PROD, sandbox: false }]) {
    for (const host of item.hosts) {
      try {
        const service = item.sandbox ? "SandboxService" : "UsersService";
        const method = item.sandbox ? "GetSandboxAccounts" : "GetAccounts";
        let accounts = (await tbank(token, host, service, method, {})).accounts || [];
        if (item.sandbox && accounts.length === 0) {
          await tbank(token, host, "SandboxService", "OpenSandboxAccount", {});
          accounts = (await tbank(token, host, service, method, {})).accounts || [];
        }
        return { host, sandbox: item.sandbox, accounts };
      } catch (error) {
        last = error instanceof Error ? error.message : "ошибка";
      }
    }
  }
  throw new Error(last);
}

function groupOf(ticker, kind) {
  const name = ticker.toUpperCase();
  const type = kind.toLowerCase();
  if (name === "LQDT" || name === "TMON" || type.includes("etf")) return "Фонды";
  if (name === "USDRUBF" || name === "CNYRUBF" || type.includes("future") || type.includes("currency")) return "Пары";
  return "Облигации";
}

async function desk(token) {
  const quote = await market();
  const built = planFrom(quote.data);
  const result = {
    source: quote.source,
    forecast: built.forecast,
    keyRate: KEY_RATE,
    gap: round1(built.forecast - KEY_RATE),
    plan: built.plan,
    yields: built.yields,
    account: null,
    note: "Запросы к Т-Банку идут через этот сервер по IPv4. VPN на компьютере их не обрывает.",
  };
  const cleaned = String(token || "").trim().replace(/^bearer\s+/i, "").replace(/\s+/g, "");
  if (!cleaned) return result;
  const link = await contour(cleaned);
  const account = link.accounts[0];
  if (!account) {
    result.note = "Счёт не найден.";
    return result;
  }
  const portfolio = await tbank(cleaned, link.host, link.sandbox ? "SandboxService" : "OperationsService", link.sandbox ? "GetSandboxPortfolio" : "GetPortfolio", { accountId: account.id });
  const positions = (portfolio.positions || []).map((item) => ({
    name: item.name || item.ticker || "Позиция",
    group: groupOf(item.ticker || "", item.instrumentType || ""),
    value: Math.abs(money(item.currentPrice) * money(item.quantity)),
  })).filter((item) => item.value > 0);
  result.account = {
    name: account.name || (link.sandbox ? "Песочница" : "Счёт"),
    total: money(portfolio.totalAmountPortfolio) || positions.reduce((sum, item) => sum + item.value, 0),
    positions,
  };
  result.note = link.sandbox ? "Подключена песочница. Заявки не отправляются." : "Подключён боевой счёт. Заявки не отправляются.";
  return result;
}

const port = Number(process.env.PORT || 8080);
createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/bonds") {
      const payload = JSON.stringify(await listBonds(true));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(payload);
      return;
    }
    if (req.method === "POST" && req.url === "/api/desk") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const payload = JSON.stringify(await desk(body.token));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(payload);
      return;
    }
    const page = await readFile(join(ROOT, "public", "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "ошибка" }));
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`carry desk http://0.0.0.0:${port}`);
});
