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

function groupOf(ticker, kind, title = "") {
  const name = String(ticker || "").toUpperCase();
  const type = String(kind || "").toLowerCase();
  const text = `${name} ${title}`.toUpperCase();
  if (name.endsWith("UTSTOM")) return "Деньги";
  if (name === "LQDT" || name === "TMON" || type.includes("etf")) return "Фонды";
  if (name === "USDRUBF" || name === "CNYRUBF" || type.includes("future")) return "Пары";
  if (type.includes("share") || type.includes("stock")) return "Акции";
  if (text.includes("CNY") || text.includes("ЮАН")) return "Юаневые облигации";
  if (text.includes("USD") || text.includes("ДОЛЛ")) return "Долларовые облигации";
  if (text.includes("EUR") || text.includes("ЕВРО")) return "Евровые облигации";
  return "Рублёвые облигации";
}

async function desk(token, accountId) {
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
  const account = link.accounts.find((item) => item.id === accountId) || link.accounts[0];
  if (!account) {
    result.note = "Счёт не найден.";
    return result;
  }
  const portfolio = await tbank(cleaned, link.host, link.sandbox ? "SandboxService" : "OperationsService", link.sandbox ? "GetSandboxPortfolio" : "GetPortfolio", { accountId: account.id });
  const positions = (portfolio.positions || []).map((item) => {
    const quantity = money(item.quantity);
    const price = money(item.currentPrice);
    const value = Math.abs(price * quantity);
    const pnl = money(item.expectedYield);
    const base = value - pnl;
    return {
      name: item.name || item.ticker || "Позиция",
      ticker: item.ticker || "",
      group: groupOf(item.ticker || "", item.instrumentType || "", item.name || ""),
      quantity,
      price,
      average: money(item.averagePositionPrice),
      value,
      pnl,
      pnlPercent: base > 0 ? (pnl / base) * 100 : 0,
    };
  }).filter((item) => item.value > 0 || item.quantity !== 0);
  const cashOnAccount = money(portfolio.totalAmountCurrencies);
  const cash = cashOnAccount || positions.filter((item) => item.group === "Деньги").reduce((sum, item) => sum + item.value, 0);
  const traded = positions.filter((item) => item.group !== "Деньги");
  const securities = money(portfolio.totalAmountShares) + money(portfolio.totalAmountBonds) + money(portfolio.totalAmountEtf);
  const futures = money(portfolio.totalAmountFutures);
  result.account = {
    id: account.id,
    name: account.name || (link.sandbox ? "Песочница" : "Счёт"),
    type: account.type || "",
    total: money(portfolio.totalAmountPortfolio) || cash + securities + futures || traded.reduce((sum, item) => sum + item.value, 0),
    cash,
    securities,
    shares: money(portfolio.totalAmountShares),
    bonds: money(portfolio.totalAmountBonds),
    etf: money(portfolio.totalAmountEtf),
    futures,
    yield: money(portfolio.expectedYield),
    positions: traded,
  };
  result.accounts = [];
  for (const item of link.accounts) {
    if (item.id === account.id) {
      result.accounts.push({ id: item.id, name: result.account.name, total: result.account.total, cash: result.account.cash });
      continue;
    }
    try {
      const other = await tbank(cleaned, link.host, link.sandbox ? "SandboxService" : "OperationsService", link.sandbox ? "GetSandboxPortfolio" : "GetPortfolio", { accountId: item.id });
      result.accounts.push({ id: item.id, name: item.name || "Счёт", total: money(other.totalAmountPortfolio), cash: money(other.totalAmountCurrencies) });
    } catch {
      result.accounts.push({ id: item.id, name: item.name || "Счёт", total: 0, cash: 0 });
    }
  }
  result.operations = await operations(cleaned, link, account.id);
  result.orders = await openOrders(cleaned, link, account.id);
  result.sandbox = link.sandbox;
  result.note = link.sandbox ? "Подключена песочница. Шаг стратегии ставит рыночные заявки на 1 лот." : "Подключён боевой счёт. Шаг ставит рыночные заявки на 1 лот только с разрешением.";
  return result;
}

async function operations(token, link, accountId) {
  try {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    const method = link.sandbox ? "GetSandboxOperations" : "GetOperations";
    const service = link.sandbox ? "SandboxService" : "OperationsService";
    const payload = await tbank(token, link.host, service, method, { accountId, from, to });
    return (payload.operations || []).slice(0, 30).map((item) => ({
      date: item.date,
      type: operationName(item.operationType || item.type),
      name: item.name || item.figi || "Операция",
      payment: money(item.payment),
      quantity: money(item.quantity),
    }));
  } catch {
    return [];
  }
}

async function openOrders(token, link, accountId) {
  try {
    const method = link.sandbox ? "GetSandboxOrders" : "GetOrders";
    const service = link.sandbox ? "SandboxService" : "OrdersService";
    const payload = await tbank(token, link.host, service, method, { accountId });
    return (payload.orders || []).map((item) => ({
      ticker: item.ticker || item.figi || "Заявка",
      lots: Number(item.lotsRequested || 0),
      done: Number(item.lotsExecuted || 0),
      direction: String(item.direction || "").includes("SELL") ? "продажа" : "покупка",
      status: item.executionReportStatus || "выставлена",
    }));
  } catch {
    return [];
  }
}

function operationName(type) {
  const names = {
    OPERATION_TYPE_BUY: "Покупка",
    OPERATION_TYPE_SELL: "Продажа",
    OPERATION_TYPE_BROKER_FEE: "Комиссия",
    OPERATION_TYPE_COUPON: "Купон",
    OPERATION_TYPE_DIVIDEND: "Дивиденд",
    OPERATION_TYPE_INPUT: "Пополнение",
    OPERATION_TYPE_OUTPUT: "Вывод",
    OPERATION_TYPE_TAX: "Налог",
  };
  return names[type] || String(type || "Операция").replace("OPERATION_TYPE_", "");
}

async function instrumentFor(token, host, ticker, query) {
  const found = await tbank(token, host, "InstrumentsService", "FindInstrument", { query: query || ticker });
  const pool = (found.instruments || []).filter((item) => item.ticker === ticker || item.isin === ticker);
  return { match: pool.find((item) => item.apiTradeAvailableFlag) || null, known: pool.length > 0 };
}

async function rublePrice(token, host, match) {
  const quote = await tbank(token, host, "MarketDataService", "GetLastPrices", { instrumentId: [match.figi || match.uid] });
  const points = money(quote.lastPrices?.[0]?.price);
  if (!String(match.instrumentType || "").toLowerCase().includes("bond")) return points;
  const bond = await tbank(token, host, "InstrumentsService", "BondBy", { idType: "INSTRUMENT_ID_TYPE_FIGI", id: match.figi });
  const nominal = money(bond.instrument?.nominal);
  return nominal ? (points / 100) * nominal : points;
}

async function trade(token, auto, sleeves, accountId) {
  const plan = Array.isArray(sleeves) ? sleeves.filter((item) => item && item.weight > 0 && item.orders?.length) : [];
  if (!auto) {
    return { attempts: plan.map((item) => ({ title: item.name, ticker: "", status: "не отправлена", detail: `по плану ${(item.weight * 100).toFixed(0)}% счёта, нет разрешения на заявки` })) };
  }
  const cleaned = String(token || "").trim().replace(/^bearer\s+/i, "").replace(/\s+/g, "");
  const link = await contour(cleaned);
  const account = link.accounts.find((item) => item.id === accountId) || link.accounts[0];
  if (!account) return { attempts: [], note: "Счёт не найден." };
  const portfolio = await tbank(cleaned, link.host, link.sandbox ? "SandboxService" : "OperationsService", link.sandbox ? "GetSandboxPortfolio" : "GetPortfolio", { accountId: account.id });
  const attempts = [];
  if (link.sandbox && money(portfolio.totalAmountPortfolio) < 50000) {
    await tbank(cleaned, link.host, "SandboxService", "SandboxPayIn", { accountId: account.id, amount: { currency: "rub", units: "1000000", nano: 0 } });
    attempts.push({ title: "Пополнение песочницы", ticker: "RUB", status: "исполнена", detail: "зачислено 1 000 000 ₽" });
  }
  const total = money(portfolio.totalAmountPortfolio);
  let budget = money(portfolio.totalAmountCurrencies) * 0.98;
  const owned = new Map((portfolio.positions || []).filter((item) => !String(item.ticker || "").endsWith("UTSTOM")).map((item) => [item.ticker, Math.abs(money(item.currentPrice) * money(item.quantity))]));
  const shorted = new Set((portfolio.positions || []).filter((item) => money(item.quantity) < 0).map((item) => item.ticker));
  for (const sleeve of plan.sort((a, b) => b.weight - a.weight)) {
    const target = total * Number(sleeve.weight);
    const have = sleeve.orders.reduce((sum, order) => sum + (owned.get(order.ticker) || 0), 0);
    let deficit = Math.min(Math.max(0, target - have), budget);
    if (deficit < 1000) {
      attempts.push({ title: sleeve.name, ticker: "", status: "пропущена", detail: `доля ${Math.round(target)} ₽ уже набрана` });
      continue;
    }
    const parts = sleeve.orders.reduce((sum, order) => sum + (Number(order.part) || 1), 0) || sleeve.orders.length;
    let carry = 0;
    for (const order of sleeve.orders) {
      const share = deficit * ((Number(order.part) || 1) / parts) + carry;
      carry = 0;
      try {
        const { match, known } = await instrumentFor(cleaned, link.host, order.ticker, order.query);
        if (!match) {
          carry += share;
          attempts.push({ title: order.title || sleeve.name, ticker: order.ticker, status: "недоступна", detail: known ? "брокер не даёт выставлять эту бумагу через API, доля перенесена" : "инструмент не найден" });
          continue;
        }
        const price = await rublePrice(cleaned, link.host, match);
        const lot = Number(match.lot || 1);
        const lotCost = price * lot;
        if (!lotCost || lotCost < 0.5) {
          attempts.push({ title: order.title, ticker: order.ticker, status: "отклонена", detail: "нет цены лота" });
          continue;
        }
        const lots = Math.min(50000, Math.floor(Math.min(share, budget) / lotCost));
        if (lots < 1) {
          attempts.push({ title: order.title, ticker: order.ticker, status: "пропущена", detail: `на лот нужно ${Math.round(lotCost)} ₽` });
          continue;
        }
        const posted = await tbank(cleaned, link.host, link.sandbox ? "SandboxService" : "OrdersService", link.sandbox ? "PostSandboxOrder" : "PostOrder", {
          quantity: String(lots),
          direction: "ORDER_DIRECTION_BUY",
          accountId: account.id,
          orderType: "ORDER_TYPE_MARKET",
          orderId: crypto.randomUUID(),
          instrumentId: match.uid || match.figi,
        });
        const spent = lots * lotCost;
        budget -= spent;
        const status = String(posted.executionReportStatus || "");
        attempts.push({ title: order.title, ticker: order.ticker, status: status.includes("FILL") ? "исполнена" : "выставлена", detail: `покупка ${lots} лот. на ~${Math.round(spent).toLocaleString("ru-RU")} ₽, цель корзины ${Math.round(target).toLocaleString("ru-RU")} ₽` });
      } catch (error) {
        const text = error instanceof Error ? error.message : "ошибка заявки";
        const detail = text.includes("not available for trading") ? "биржа сейчас не принимает заявку" : text.includes("Not enough") ? "не хватает средств или маржи" : text.slice(0, 180);
        attempts.push({ title: order.title || sleeve.name, ticker: order.ticker, status: "отклонена", detail });
      }
    }
    if (sleeve.hedge && !shorted.has(sleeve.hedge.ticker)) {
      try {
        const { match } = await instrumentFor(cleaned, link.host, sleeve.hedge.ticker, sleeve.hedge.query);
        if (!match) {
          attempts.push({ title: sleeve.hedge.title, ticker: sleeve.hedge.ticker, status: "недоступна", detail: "хедж не найден" });
        } else {
          const posted = await tbank(cleaned, link.host, link.sandbox ? "SandboxService" : "OrdersService", link.sandbox ? "PostSandboxOrder" : "PostOrder", {
            quantity: "1",
            direction: "ORDER_DIRECTION_SELL",
            accountId: account.id,
            orderType: "ORDER_TYPE_MARKET",
            orderId: crypto.randomUUID(),
            instrumentId: match.uid || match.figi,
          });
          const status = String(posted.executionReportStatus || "");
          attempts.push({ title: sleeve.hedge.title, ticker: sleeve.hedge.ticker, status: status.includes("FILL") ? "исполнена" : "выставлена", detail: "шорт 1 лот фьючерса под валютную облигацию" });
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : "ошибка заявки";
        attempts.push({ title: sleeve.hedge.title, ticker: sleeve.hedge.ticker, status: "отклонена", detail: text.includes("not available") ? "биржа сейчас не принимает фьючерс" : text.slice(0, 160) });
      }
    }
  }
  if (!attempts.length) attempts.push({ title: "Шаг", ticker: "", status: "пусто", detail: "в плане нет долей с выбранными бумагами" });
  return { attempts, sandbox: link.sandbox };
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
    if (req.method === "POST" && req.url === "/api/step") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const payload = JSON.stringify(await trade(body.token, Boolean(body.auto), body.sleeves, body.accountId));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(payload);
      return;
    }
    if (req.method === "POST" && req.url === "/api/desk") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const payload = JSON.stringify(await desk(body.token, body.accountId));
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
