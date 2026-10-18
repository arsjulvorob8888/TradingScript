import { request as httpsRequest } from "node:https";
import { setDefaultResultOrder } from "node:dns";

setDefaultResultOrder("ipv4first");

let cache = null;

function http(url) {
  const once = (secure) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const req = httpsRequest(
        {
          hostname: target.hostname,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers: { "User-Agent": "Mozilla/5.0" },
          rejectUnauthorized: secure,
          family: 4,
          timeout: secure ? 5000 : 12000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.end();
    });
  return once(true).catch(() => once(false));
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function frequency(days, details) {
  if (days) {
    if (days <= 35) return "каждый месяц";
    if (days <= 100) return "раз в квартал";
    if (days <= 200) return "раз в полгода";
    return "раз в год";
  }
  return details || "не указана";
}

function ratingOf(kind, level, ytm, price) {
  if (kind === "ОФЗ") return { rating: "ОФЗ", risk: "низкий" };
  const distressed = ytm >= 22 || (price !== null && price < 90);
  if (level === 1) return { rating: "1 уровень", risk: distressed ? "средний" : "низкий" };
  if (level === 2) return { rating: "2 уровень", risk: distressed ? "высокий" : "средний" };
  if (level === 3) return { rating: "3 уровень", risk: "высокий" };
  return { rating: "не указан", risk: distressed ? "высокий" : "средний" };
}

function currencyOf(face) {
  if (face === "USD") return "USD";
  if (face === "CNY") return "CNY";
  if (face === "EUR") return "EUR";
  return "RUB";
}

const HISTORY_COLUMNS =
  "SECID,SHORTNAME,CLOSE,YIELDCLOSE,YIELDTOOFFER,DURATION,COUPONPERCENT,VALUE,MATDATE,FACEUNIT,COUPON_DETAILS,OFFERDATE";

async function history(board, kind, date) {
  const url =
    `https://iss.moex.com/iss/history/engines/stock/markets/bonds/boards/${board}/securities.json` +
    `?date=${date}&iss.meta=off&sort_column=VALUE&sort_order=desc&limit=100&history.columns=${HISTORY_COLUMNS}`;
  const payload = JSON.parse(await http(url));
  const columns = payload.history?.columns || [];
  const bonds = [];
  for (const row of payload.history?.data || []) {
    const record = Object.fromEntries(columns.map((name, index) => [name, row[index]]));
    const ytm = num(record.YIELDCLOSE);
    if (!ytm || ytm <= 0 || ytm > 80) continue;
    const price = num(record.CLOSE);
    const coupon = num(record.COUPONPERCENT);
    const currency = currencyOf(record.FACEUNIT ? String(record.FACEUNIT) : null);
    const maturity = record.MATDATE && record.MATDATE !== "0000-00-00" ? String(record.MATDATE) : null;
    bonds.push({
      secid: String(record.SECID),
      name: String(record.SHORTNAME),
      currency,
      kind: currency === "RUB" ? kind : "Валютная",
      ytm: Math.round(ytm * 100) / 100,
      offerYield: num(record.YIELDTOOFFER),
      coupon,
      couponYield: coupon !== null && price ? Math.round((coupon / (price / 100)) * 100) / 100 : null,
      periodDays: null,
      frequency: frequency(null, record.COUPON_DETAILS ? String(record.COUPON_DETAILS) : null),
      nextCoupon: record.OFFERDATE ? `оферта ${record.OFFERDATE}` : null,
      maturity,
      durationDays: num(record.DURATION) ? Math.round(Number(record.DURATION)) : null,
      price,
      turnover: Math.round(Number(record.VALUE || 0)),
      ...ratingOf(currency === "RUB" ? kind : "Валютная", null, ytm, price),
    });
  }
  return bonds;
}

async function periods(board) {
  const url =
    `https://iss.moex.com/iss/engines/stock/markets/bonds/boards/${board}/securities.json?iss.meta=off&iss.only=securities` +
    "&securities.columns=SECID,COUPONPERIOD,NEXTCOUPON,LISTLEVEL";
  const payload = JSON.parse(await http(url));
  return new Map(
    (payload.securities?.data || []).map((row) => [String(row[0]), { days: num(row[1]), next: row[2] ? String(row[2]) : null, level: num(row[3]) }]),
  );
}

async function enrich(bonds, board) {
  try {
    const extra = await periods(board);
    return bonds.map((bond) => {
      const item = extra.get(bond.secid);
      if (!item) return bond;
      const rated = ratingOf(bond.kind, item.level, bond.ytm, bond.price);
      return { ...bond, periodDays: item.days, frequency: frequency(item.days, bond.frequency), nextCoupon: item.next || bond.nextCoupon, ...rated };
    });
  } catch {
    return bonds;
  }
}

async function priceMove(ticker) {
  const payload = JSON.parse(
    await http(
      `https://iss.moex.com/iss/history/engines/futures/markets/forts/securities/${ticker}.json?from=2026-07-01&iss.meta=off&history.columns=TRADEDATE,SETTLEPRICE`,
    ),
  );
  const prices = (payload.history?.data || []).map((row) => Number(row[1])).filter((price) => price > 0);
  if (prices.length < 40) return 0;
  const last = prices[prices.length - 1];
  const base = prices[Math.max(0, prices.length - 60)];
  return Math.round((last / base - 1) * 1000) / 10;
}

async function funding(ticker) {
  const payload = JSON.parse(
    await http(
      `https://iss.moex.com/iss/history/engines/futures/markets/forts/securities/${ticker}.json?from=2026-10-01&iss.meta=off&history.columns=TRADEDATE,SETTLEPRICE,SWAPRATE`,
    ),
  );
  const fresh = [...(payload.history?.data || [])].reverse().find((row) => row[1] && row[2]);
  return fresh ? (fresh[2] / fresh[1]) * 365 * 100 : null;
}

async function fundYield(ticker) {
  const payload = JSON.parse(
    await http(
      `https://iss.moex.com/iss/history/engines/stock/markets/shares/boards/TQBR/securities/${ticker}.json?from=2026-09-01&iss.meta=off&history.columns=TRADEDATE,CLOSE,LEGALCLOSEPRICE`,
    ),
  );
  const rows = (payload.history?.data || []).map((row) => ({ date: row[0], price: Number(row[2] || row[1]) })).filter((row) => row.price);
  if (rows.length < 2) return null;
  const sample = rows.slice(-11);
  const days = Math.max((Date.parse(sample[sample.length - 1].date) - Date.parse(sample[0].date)) / 86_400_000, 1);
  return (sample[sample.length - 1].price / sample[0].price - 1) * (365 / days) * 100;
}

async function latest(board, kind) {
  for (const date of ["2026-10-16", "2026-10-15", "2026-10-14"]) {
    const rows = await history(board, kind, date);
    if (rows.length) return rows;
  }
  return [];
}

export async function listBonds(refresh = false) {
  if (!refresh && cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.board;
  const [ofz, corporate, usd, cny, usdFunding, cnyFunding, usdMove, cnyMove, lqdt, tmon] = await Promise.all([
    latest("TQOB", "ОФЗ").then((rows) => enrich(rows, "TQOB")),
    latest("TQCB", "Корпоративная").then((rows) => enrich(rows, "TQCB")),
    latest("TQOD", "Валютная").then((rows) => enrich(rows, "TQOD")).catch(() => []),
    latest("TQOY", "Валютная").then((rows) => enrich(rows, "TQOY")).catch(() => []),
    funding("USDRUBF").catch(() => null),
    funding("CNYRUBF").catch(() => null),
    priceMove("USDRUBF").catch(() => 0),
    priceMove("CNYRUBF").catch(() => 0),
    fundYield("LQDT").catch(() => null),
    fundYield("TMON").catch(() => null),
  ]);
  const bonds = [...ofz, ...corporate.filter((bond) => bond.turnover >= 1_000_000), ...usd, ...cny].sort((a, b) => b.ytm - a.ytm);
  const board = {
    updated: new Date().toISOString(),
    keyRate: 14,
    fundingUsd: Math.round((usdFunding ?? 5) * 10) / 10,
    fundingCny: Math.round((cnyFunding ?? 8.6) * 10) / 10,
    usdMove: usdMove || 0,
    cnyMove: cnyMove || 0,
    lqdt: Math.round((lqdt ?? 13.53) * 10) / 10,
    tmon: Math.round((tmon ?? 12.93) * 10) / 10,
    bonds,
  };
  cache = { at: Date.now(), board };
  return board;
}
