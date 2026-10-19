import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  const weights = { usd: 0.4, cny: 0.2, rub: 0.25, lqdt: 0.1, tmon: 0.05 };
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
    const average = money(item.averagePositionPrice);
    const value = Math.abs(price * quantity);
    const brokerPnl = money(item.expectedYield);
    const pricePnl = average ? (price - average) * quantity : 0;
    const pnl = brokerPnl !== 0 ? brokerPnl : pricePnl;
    const cost = average ? Math.abs(average * quantity) : Math.abs(value - pnl);
    return {
      name: item.name || item.ticker || "Позиция",
      ticker: item.ticker || "",
      group: groupOf(item.ticker || "", item.instrumentType || "", item.name || ""),
      quantity,
      price,
      average,
      value,
      pnl,
      pnlPercent: cost > 0 ? (pnl / cost) * 100 : 0,
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
    total: Math.max(money(portfolio.totalAmountPortfolio), cash + traded.reduce((sum, item) => sum + item.value, 0)),
    cash,
    securities,
    shares: money(portfolio.totalAmountShares),
    bonds: money(portfolio.totalAmountBonds),
    etf: money(portfolio.totalAmountEtf),
    futures,
    yield: money(portfolio.expectedYield) || traded.reduce((sum, item) => sum + item.pnl, 0),
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
  if (!memory.opened || typeof memory.opened !== "object") memory.opened = {};
  for (const op of result.operations) {
    if (!op.ticker || !op.date || !/Покупка|Продажа/.test(op.type)) continue;
    const prev = memory.opened[op.ticker];
    if (!prev || Date.parse(op.date) < Date.parse(prev)) memory.opened[op.ticker] = op.date;
  }
  const live = new Set(traded.map((item) => item.ticker));
  for (const ticker of Object.keys(memory.opened)) if (!live.has(ticker)) delete memory.opened[ticker];
  for (const item of traded) {
    if (!memory.opened[item.ticker]) memory.opened[item.ticker] = new Date().toISOString();
    item.opened = memory.opened[item.ticker];
  }
  await storeState();
  result.orders = await openOrders(cleaned, link, account.id);
  result.sandbox = link.sandbox;
  result.note = link.sandbox ? "Подключена песочница." : "Подключён боевой счёт.";
  return result;
}

async function operations(token, link, accountId) {
  try {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 120 * 86400000).toISOString();
    const method = link.sandbox ? "GetSandboxOperations" : "GetOperations";
    const service = link.sandbox ? "SandboxService" : "OperationsService";
    const payload = await tbank(token, link.host, service, method, { accountId, from, to });
    return (payload.operations || []).map((item) => ({
      date: item.date,
      type: operationName(item.operationType || item.type),
      name: item.name || item.figi || "Операция",
      payment: money(item.payment),
      ticker: item.ticker || "",
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
      orderId: item.orderId,
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

async function fxRub(token, host, ticker) {
  try {
    const { match } = await instrumentFor(token, host, ticker, ticker);
    if (!match) return null;
    const quote = await tbank(token, host, "MarketDataService", "GetLastPrices", { instrumentId: [match.figi || match.uid] });
    const points = money(quote.lastPrices?.[0]?.price);
    if (!points) return null;
    return points > 1000 ? points / 1000 : points;
  } catch {
    return null;
  }
}

async function rublePrice(token, host, match) {
  const quote = await tbank(token, host, "MarketDataService", "GetLastPrices", { instrumentId: [match.figi || match.uid] });
  const points = money(quote.lastPrices?.[0]?.price);
  if (!String(match.instrumentType || "").toLowerCase().includes("bond")) return points;
  const bond = await tbank(token, host, "InstrumentsService", "BondBy", { idType: "INSTRUMENT_ID_TYPE_FIGI", id: match.figi });
  const nominal = money(bond.instrument?.nominal);
  const currency = String(bond.instrument?.nominal?.currency || bond.instrument?.currency || "rub").toLowerCase();
  let price = nominal ? (points / 100) * nominal : points;
  if (currency.includes("usd")) price *= (await fxRub(token, host, "USDRUBF")) || 90;
  else if (currency.includes("cny") || currency.includes("cnh")) price *= (await fxRub(token, host, "CNYRUBF")) || 12;
  return price;
}

function explainFailure(text) {
  const raw = String(text || "");
  if (raw.includes("not available") || raw.includes("30079")) {
    return { status: "биржа закрыта", detail: "Биржа не принимает заявку по этой бумаге.", action: "Если сейчас выходной, вечер или пауза между сессиями — оставьте стратегию запущенной. Основная сессия 10:00–18:50 мск. Вечером многие облигации не торгуются." };
  }
  if (raw.includes("Not enough") || raw.includes("30034") || raw.includes("не хватает")) {
    return { status: "не хватает денег", detail: "На эту заявку не хватило свободных рублей или гарантийного обеспечения.", action: "Пара покупается первой. Уменьшите сумму в поле заявки или дождитесь, пока на счёте снова будут рубли." };
  }
  return { status: "отклонена", detail: raw.slice(0, 160), action: "Если отказ повторяется, уберите бумагу из стратегии и выберите другую ликвидную с тем же риском." };
}

async function trade(token, auto, sleeves, accountId) {
  const plan = Array.isArray(sleeves) ? sleeves.filter((item) => item && item.weight > 0 && item.orders?.length) : [];
  if (!auto) {
    return { attempts: plan.map((item) => ({ sleeve: item.name, title: item.name, ticker: "", status: "нет разрешения", detail: `По плану ${(item.weight * 100).toFixed(0)}% счёта, заявка не отправлена.`, action: "Включите «Разрешить заявки без отдельного подтверждения» и повторите шаг." })) };
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
  const owned = new Map((portfolio.positions || []).filter((item) => !String(item.ticker || "").endsWith("UTSTOM")).map((item) => [item.ticker, Math.abs(money(item.currentPrice) * money(item.quantity))]));
  const qty = new Map((portfolio.positions || []).filter((item) => !String(item.ticker || "").endsWith("UTSTOM")).map((item) => [item.ticker, Math.abs(money(item.quantity))]));
  const cashRaw = money(portfolio.totalAmountCurrencies);
  const marked = (portfolio.positions || []).filter((item) => groupOf(item.ticker || "", item.instrumentType || "", item.name || "") !== "Деньги" && !String(item.ticker || "").endsWith("UTSTOM")).reduce((sum, item) => sum + Math.abs(money(item.currentPrice) * money(item.quantity)), 0) + cashRaw;
  const total = Math.max(money(portfolio.totalAmountPortfolio), marked);
  let budget = cashRaw * 0.98;
  const shortQty = new Map((portfolio.positions || []).filter((item) => money(item.quantity) < 0).map((item) => [item.ticker, Math.abs(money(item.quantity))]));
  const rankOf = (name) => /доллар|юань|пара/i.test(name) ? 0 : /руб/i.test(name) ? 1 : 2;
  const ordered = [...plan].sort((a, b) => rankOf(a.name) - rankOf(b.name) || Number(b.weight) - Number(a.weight));
  const unmet = new Map(ordered.map((sleeve) => {
    const target = total * Number(sleeve.weight);
    const have = sleeve.orders.reduce((sum, order) => sum + (owned.get(order.ticker) || 0), 0);
    return [sleeve, Math.max(0, target - have)];
  }));
  let pairWaiting = false;
  const pairNeed = ordered.filter((sleeve) => rankOf(sleeve.name) === 0).reduce((sum, sleeve) => sum + (unmet.get(sleeve) || 0), 0);
  attempts.push({ sleeve: "Пары", title: "Пара", ticker: "", status: pairNeed > 1000 ? "добираю" : "набрано", detail: `Счёт для плана ${Math.round(total).toLocaleString("ru-RU")} ₽, свободно ${Math.round(budget).toLocaleString("ru-RU")} ₽, паре не хватает ${Math.round(pairNeed).toLocaleString("ru-RU")} ₽.`, why: pairNeed > budget + 1000 ? "Свободных рублей меньше, чем дыра в паре. Сначала продаю лишние фонды, затем лишние рублёвые облигации." : pairNeed > 1000 ? "Рублей на пару хватает. Другие корзины не покупаю, пока пара не собрана." : "Пара уже в плане, докупать её не нужно.", action: "Пара всегда первая. Если она не полная — это ещё не конец шага, а очередь." });
  const resting = await openOrders(cleaned, link, account.id);
  const pairTickers = new Set(ordered.filter((sleeve) => rankOf(sleeve.name) === 0).flatMap((sleeve) => [...sleeve.orders.map((order) => order.ticker), sleeve.hedge?.ticker].filter(Boolean)));
  if (pairNeed > 1000) {
    for (const order of resting) {
      if (!order.orderId || pairTickers.has(order.ticker)) continue;
      try {
        await tbank(cleaned, link.host, link.sandbox ? "SandboxService" : "OrdersService", link.sandbox ? "CancelSandboxOrder" : "CancelOrder", { accountId: account.id, orderId: order.orderId });
        attempts.push({ sleeve: "Заявки", title: order.ticker, ticker: order.ticker, status: "снята", detail: "Лишняя заявка снята, чтобы деньги ушли в валютную пару.", why: "Пропорция ещё не собрана.", action: "Ничего делать не нужно." });
      } catch { /* заявка уже не активна */ }
    }
  }
  if (pairNeed > budget + 1000) {
    const donors = ordered.filter((sleeve) => rankOf(sleeve.name) > 0).sort((a, b) => rankOf(b.name) - rankOf(a.name));
    for (const sleeve of donors) {
      if (pairNeed <= budget + 1000) break;
      const targetValue = total * Number(sleeve.weight);
      let have = sleeve.orders.reduce((sum, order) => sum + (owned.get(order.ticker) || 0), 0);
      let room = Math.max(0, have - targetValue);
      if (pairNeed > budget + room + 1000) room = have;
      for (const order of sleeve.orders) {
        if (room < 1000 || pairNeed <= budget + 1000) break;
        const heldValue = owned.get(order.ticker) || 0;
        if (heldValue < 1000) continue;
        try {
          const { match } = await instrumentFor(cleaned, link.host, order.ticker, order.query);
          if (!match) continue;
          const price = await rublePrice(cleaned, link.host, match);
          const lot = Number(match.lot || 1);
          const lotCost = price * lot;
          const cut = Math.min(heldValue, room, Math.max(0, pairNeed - budget));
          const lots = lotCost >= 1 ? Math.min(50000, Math.floor(cut / lotCost)) : 1;
          if (lots < 1) continue;
          await tbank(cleaned, link.host, link.sandbox ? "SandboxService" : "OrdersService", link.sandbox ? "PostSandboxOrder" : "PostOrder", {
            quantity: String(lots),
            direction: "ORDER_DIRECTION_SELL",
            accountId: account.id,
            orderType: "ORDER_TYPE_MARKET",
            orderId: crypto.randomUUID(),
            instrumentId: match.uid || match.figi,
          });
          const proceeds = lotCost >= 1 ? lots * lotCost : cut;
          budget += proceeds * 0.98;
          owned.set(order.ticker, Math.max(0, heldValue - proceeds));
          have = Math.max(0, have - proceeds);
          room -= proceeds;
          unmet.set(sleeve, Math.max(0, targetValue - have));
          attempts.push({ sleeve: sleeve.name, title: order.title || sleeve.name, ticker: order.ticker, status: "продана", detail: `Продано ${lots} лот. на ~${Math.round(proceeds).toLocaleString("ru-RU")} ₽, чтобы собрать валютную пару.`, why: "Доля была больше плана, а на облигации пары не хватало рублей.", action: "Ничего делать не нужно." });
        } catch (error) {
          const failure = explainFailure(error instanceof Error ? error.message : "ошибка продажи");
          attempts.push({ sleeve: sleeve.name, title: order.title || sleeve.name, ticker: order.ticker, status: failure.status, detail: failure.detail, why: "Продажа нужна, чтобы высвободить рубли под валютную пару.", action: failure.action });
        }
      }
    }
  }
  for (const sleeve of ordered) {
    const rank = rankOf(sleeve.name);
    const target = total * Number(sleeve.weight);
    const have = sleeve.orders.reduce((sum, order) => sum + (owned.get(order.ticker) || 0), 0);
    const gap = unmet.get(sleeve) || 0;
    const reserved = ordered.filter((item) => rankOf(item.name) < rank).reduce((sum, item) => sum + (unmet.get(item) || 0), 0);
    const available = Math.max(0, budget - reserved);
    if (rank > 0 && pairWaiting) {
      attempts.push({ sleeve: sleeve.name, title: sleeve.name, ticker: "", status: "ждёт пару", detail: `Свободно ${Math.round(budget).toLocaleString("ru-RU")} ₽, они оставлены под валютные пары.`, why: "Очередь: сначала шорт фьючерса и валютная облигация, затем рублёвые, затем фонды.", action: "Ничего докупать здесь не нужно, пока пара не собрана." });
      continue;
    }
    const manualOrders = sleeve.orders.filter((order) => order.limit !== undefined && order.limit !== null && order.limit !== "");
    const manualSum = manualOrders.reduce((sum, order) => sum + Math.max(0, Number(order.limit) || 0), 0);
    let deficit = Math.min(gap, available);
    if (manualOrders.length === sleeve.orders.length) deficit = Math.min(deficit, manualSum);
    if (gap < 1000) {
      attempts.push({ sleeve: sleeve.name, title: sleeve.name, ticker: "", status: "набрано", detail: `Уже ${Math.round(have).toLocaleString("ru-RU")} ₽ из ${Math.round(target).toLocaleString("ru-RU")} ₽.`, why: "Доля плана заполнена, докупать нечего.", action: "Ничего делать не нужно." });
      unmet.set(sleeve, 0);
      continue;
    }
    if (deficit < 1000) {
      attempts.push({ sleeve: sleeve.name, title: sleeve.name, ticker: "", status: "ждёт очередь", detail: `Нужно ${Math.round(gap).toLocaleString("ru-RU")} ₽, доступно ${Math.round(available).toLocaleString("ru-RU")} ₽: остальное зарезервировано под более раннюю корзину.`, why: "Очередь: пары, потом рублёвые облигации, потом фонды.", action: "Пополните рубли или уменьшите сумму более приоритетной заявки." });
      if (rank === 0) pairWaiting = true;
      continue;
    }
    const parts = sleeve.orders.reduce((sum, order) => sum + (Number(order.part) || 1), 0) || sleeve.orders.length;
    let carry = 0;
    let spentSleeve = 0;
    let pairFailed = false;
    for (const order of sleeve.orders) {
      if (order.limit === 0 || order.limit === "0") {
        attempts.push({ sleeve: sleeve.name, title: order.title || sleeve.name, ticker: order.ticker, status: "пропущена", detail: "Сумма вручную стоит 0.", action: "Впишите сумму в рублях или очистите поле, чтобы взять план." });
        continue;
      }
      const share = (order.limit !== undefined && order.limit !== null && order.limit !== "" ? Number(order.limit) : deficit * ((Number(order.part) || 1) / parts)) + carry;
      carry = 0;
      try {
        const { match, known } = await instrumentFor(cleaned, link.host, order.ticker, order.query);
        if (!match) {
          carry += share;
          attempts.push({ sleeve: sleeve.name, title: order.title || sleeve.name, ticker: order.ticker, status: "недоступна", detail: known ? "Брокер не даёт выставлять эту бумагу через API." : "Инструмент не найден в Т-Банке.", why: `Нужно было докупить около ${Math.round(share).toLocaleString("ru-RU")} ₽ в «${sleeve.name}».`, action: known ? "Выберите другую ликвидную бумагу той же категории." : "Проверьте тикер на странице «Облигации»." });
          continue;
        }
        const price = await rublePrice(cleaned, link.host, match);
        const lot = Number(match.lot || 1);
        const knownUnit = (qty.get(order.ticker) || 0) > 0 ? (owned.get(order.ticker) || 0) / qty.get(order.ticker) : 0;
        let lotCost = knownUnit > 500 ? knownUnit * lot : price * lot;
        const bond = String(match.instrumentType || "").toLowerCase().includes("bond");
        let lots = !lotCost || lotCost < 0.5 ? 0 : Math.min(50000, Math.floor(Math.min(share, budget) / lotCost));
        if (bond && (!lotCost || lotCost < 500)) {
          lots = Math.min(share, budget) >= 1000 ? 1 : 0;
          lotCost = 0;
        }
        if (lots < 1) {
          attempts.push({ sleeve: sleeve.name, title: order.title, ticker: order.ticker, status: "пропущена", detail: `На лот нужно ${Math.round(price * lot || 0).toLocaleString("ru-RU")} ₽, а на эту бумагу сейчас отведено ${Math.round(Math.min(share, budget)).toLocaleString("ru-RU")} ₽.`, action: "Увеличьте сумму в поле заявки или дождитесь, пока освободятся рубли." });
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
        const spent = lotCost ? lots * lotCost : 0;
        budget -= spent;
        spentSleeve += spent;
        const status = String(posted.executionReportStatus || "");
        attempts.push({ sleeve: sleeve.name, title: order.title, ticker: order.ticker, status: status.includes("FILL") ? "исполнена" : "выставлена", detail: `Покупка ${lots} лот. на ~${Math.round(spent).toLocaleString("ru-RU")} ₽. Приоритет: ${rank === 0 ? "пара" : rank === 1 ? "рублёвые" : "фонды"}.`, why: `До плана корзины не хватало ${Math.round(gap).toLocaleString("ru-RU")} ₽.`, action: "Ничего делать не нужно." });
      } catch (error) {
        const failure = explainFailure(error instanceof Error ? error.message : "ошибка заявки");
        if (failure.status === "не хватает денег" && rank === 0) pairFailed = true;
        attempts.push({ sleeve: sleeve.name, title: order.title || sleeve.name, ticker: order.ticker, status: failure.status, detail: failure.detail, why: `Заявка в «${sleeve.name}» на около ${Math.round(share).toLocaleString("ru-RU")} ₽. Свободно было ${Math.round(budget).toLocaleString("ru-RU")} ₽.`, action: failure.action });
      }
    }
    unmet.set(sleeve, Math.max(0, gap - spentSleeve));
    if (rank === 0 && (unmet.get(sleeve) || 0) > 1000) pairWaiting = true;
    if (sleeve.hedge && have + spentSleeve > 1000) {
      try {
        const { match } = await instrumentFor(cleaned, link.host, sleeve.hedge.ticker, sleeve.hedge.query);
        if (!match) {
          attempts.push({ sleeve: sleeve.name, title: sleeve.hedge.title, ticker: sleeve.hedge.ticker, status: "недоступна", detail: "Хедж не найден.", action: "Шорт фьючерса не выставлен. Проверьте USDRUBF или CNYRUBF." });
        } else {
          const futurePrice = await rublePrice(cleaned, link.host, match);
          const notional = futurePrice > 1000 ? futurePrice : futurePrice * 1000;
          const need = Math.max(1, Math.round((have + spentSleeve) / Math.max(notional, 1)));
          const add = need - (shortQty.get(sleeve.hedge.ticker) || 0);
          if (add < 1) {
            attempts.push({ sleeve: sleeve.name, title: sleeve.hedge.title, ticker: sleeve.hedge.ticker, status: "набрано", detail: "Шорт уже покрывает купленные облигации.", action: "Ничего делать не нужно." });
          } else {
            const posted = await tbank(cleaned, link.host, link.sandbox ? "SandboxService" : "OrdersService", link.sandbox ? "PostSandboxOrder" : "PostOrder", {
              quantity: String(add),
              direction: "ORDER_DIRECTION_SELL",
              accountId: account.id,
              orderType: "ORDER_TYPE_MARKET",
              orderId: crypto.randomUUID(),
              instrumentId: match.uid || match.figi,
            });
            const status = String(posted.executionReportStatus || "");
            attempts.push({ sleeve: sleeve.name, title: sleeve.hedge.title, ticker: sleeve.hedge.ticker, status: status.includes("FILL") ? "исполнена" : "выставлена", detail: `Шорт ${add} контр. Объём одного контракта ~${Math.round(notional).toLocaleString("ru-RU")} ₽, облигации ~${Math.round(have + spentSleeve).toLocaleString("ru-RU")} ₽. Это не гарантийное обеспечение, а размер хеджа.`, why: "Шорт сравнивается с суммой валютных облигаций. Пока суммы не близки, пара не в равновесии.", action: "Ничего делать не нужно." });
          }
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : "ошибка заявки";
        const failure = explainFailure(text);
        if (failure.status === "не хватает денег") pairWaiting = true;
        attempts.push({ sleeve: sleeve.name, title: sleeve.hedge.title, ticker: sleeve.hedge.ticker, status: failure.status, detail: failure.detail, why: "Шорт нужен, чтобы валютная облигация была захеджирована.", action: failure.action });
      }
    }
  }
  if (!attempts.length) attempts.push({ sleeve: "Стратегия", title: "Шаг", status: "нет поручений", detail: "Корзины для покупки не переданы.", action: "Если выбрано «Оставить в рублях», так и задумано. Иначе добавьте бумаги в нужную категорию." });
  return { attempts, sandbox: link.sandbox };
}

const port = Number(process.env.PORT || 8080);
const STATE_PATH = join(ROOT, "data", "state.json");
const EVERY = 10 * 60 * 1000;
const memory = { token: "", accountId: "", active: false, auto: false, sleeves: [], updated: "" };
const cache = { at: 0, bonds: null, deskKey: "", desk: null, decision: null };
let ticking = false;

async function loadState() {
  try {
    Object.assign(memory, JSON.parse(await readFile(STATE_PATH, "utf8")));
  } catch { /* первый запуск */ }
}

async function storeState() {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify({ token: memory.token, accountId: memory.accountId, active: memory.active, auto: memory.auto, sleeves: memory.sleeves, opened: memory.opened || {}, updated: memory.updated }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function withServer(payload) {
  const when = cache.at ? new Date(cache.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
  const mode = memory.active ? (memory.auto ? "Сервер сам обновляет счёт и добирает доли плана." : "Сервер сам обновляет счёт. Заявки выключены.") : "Сервер ждёт запуска стратегии.";
  return { ...payload, serverAt: cache.at ? new Date(cache.at).toISOString() : "", decision: cache.decision, note: [payload?.note, when ? `${mode} Последнее обновление ${when}.` : mode].filter(Boolean).join(" ") };
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    cache.bonds = await listBonds(true);
    if (memory.token) {
      cache.desk = await desk(memory.token, memory.accountId);
      cache.deskKey = `${memory.token}:${memory.accountId || ""}`;
      if (memory.active && memory.auto && memory.sleeves.length) {
        const decision = await trade(memory.token, true, memory.sleeves, memory.accountId);
        cache.decision = { at: new Date().toISOString(), attempts: decision.attempts || [] };
        cache.desk = await desk(memory.token, memory.accountId);
      }
    }
    cache.at = Date.now();
    memory.updated = new Date(cache.at).toISOString();
    await storeState();
  } catch (error) {
    cache.decision = { at: new Date().toISOString(), attempts: [{ title: "Сервер", status: "ошибка", detail: error instanceof Error ? error.message : "сбой обновления" }] };
  } finally {
    ticking = false;
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/state") {
      const body = await readBody(req);
      memory.token = String(body.token || memory.token || "").trim();
      memory.accountId = String(body.accountId || "");
      memory.active = Boolean(body.active);
      memory.auto = Boolean(body.auto);
      memory.sleeves = Array.isArray(body.sleeves) ? body.sleeves : [];
      memory.updated = new Date().toISOString();
      await storeState();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, everyMinutes: 10 }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/bonds") {
      if (!cache.bonds || Date.now() - cache.at > EVERY) cache.bonds = await listBonds(true);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(cache.bonds));
      return;
    }
    if (req.method === "POST" && req.url === "/api/step") {
      const body = await readBody(req);
      const payload = JSON.stringify(await trade(body.token, Boolean(body.auto), body.sleeves, body.accountId));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(payload);
      return;
    }
    if (req.method === "POST" && req.url === "/api/desk") {
      const body = await readBody(req);
      const key = `${body.token || ""}:${body.accountId || ""}`;
      const fresh = cache.desk && cache.deskKey === key && Date.now() - cache.at < EVERY;
      const payload = fresh && !body.force ? cache.desk : await desk(body.token, body.accountId);
      if (!fresh || body.force) {
        cache.desk = payload;
        cache.deskKey = key;
        cache.at = Date.now();
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(withServer(payload)));
      return;
    }
    if (req.method === "POST" && req.url === "/api/pulse") {
      await tick();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, at: cache.at, active: memory.active, auto: memory.auto }));
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
  loadState().then(() => tick());
  setInterval(tick, EVERY);
});
