// Relais de données d'actions pour VirtualTrade.
// Source 1 : Finnhub (si la variable FINNHUB_KEY existe, la clé reste cachée côté serveur).
// Source 2 : Yahoo Finance (API non officielle, sans clé) : cours ET historique.
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; VirtualTrade)', 'Accept': 'application/json' };
const cache = {};
const get = (k, ttl) => { const c = cache[k]; return c && Date.now() - c.t < ttl ? c.d : null; };
const put = (k, d) => {
  cache[k] = { t: Date.now(), d };
  if (Object.keys(cache).length > 600) for (const x in cache) if (Date.now() - cache[x].t > 600000) delete cache[x];
  return d;
};
const J = async (u, h) => { const r = await fetch(u, { headers: h || UA }); if (!r.ok) throw new Error(r.status); return r.json(); };
const RANGES = [['1d', '5m'], ['5d', '15m'], ['1mo', '60m'], ['3mo', '1d'], ['1y', '1d'], ['max', '1wk']];

async function yahooChart(sym, range, interval) {
  for (const host of ['query1', 'query2']) {
    try {
      return await J('https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) +
        '?range=' + range + '&interval=' + interval + '&includePrePost=false');
    } catch (e) { /* essaie l'hôte suivant */ }
  }
  throw new Error('yahoo');
}

async function quote(sym, key) {
  const c = get('q:' + sym, 60000);
  if (c) return c;
  if (key) {
    try {
      const d = await J('https://finnhub.io/api/v1/quote?symbol=' + sym + '&token=' + key, {});
      if (d && d.c > 0) return put('q:' + sym, { c: d.c, dp: d.dp || 0, t: d.t, src: 'finnhub' });
    } catch (e) { /* bascule sur Yahoo */ }
  }
  const m = (await yahooChart(sym, '1d', '1d')).chart.result[0].meta;
  const prev = m.chartPreviousClose || m.previousClose;
  if (!(m.regularMarketPrice > 0)) throw new Error('no price');
  return put('q:' + sym, { c: m.regularMarketPrice, dp: prev ? (m.regularMarketPrice / prev - 1) * 100 : 0, t: m.regularMarketTime, src: 'yahoo' });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const x = items[i++]; try { await fn(x); } catch (e) { /* ignoré */ } }
  }));
}

exports.handler = async (event) => {
  const key = process.env.FINNHUB_KEY || '';
  const p = event.queryStringParameters || {};
  const hdr = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=30, s-maxage=60',
    'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120'
  };
  const ok = (b) => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const bad = (c, m) => ({ statusCode: c, body: JSON.stringify({ error: m }) });
  try {
    if (p.q) {
      const q = String(p.q).slice(0, 40).trim();
      if (!q) return bad(400, 'q');
      const c = get('s:' + q.toLowerCase(), 600000);
      if (c) return ok(c);
      let res;
      if (key) { try { res = await J('https://finnhub.io/api/v1/search?q=' + encodeURIComponent(q) + '&token=' + key, {}); } catch (e) { /* Yahoo */ } }
      if (!res || !res.result) {
        const y = await J('https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=8&newsCount=0');
        res = { result: (y.quotes || []).filter(x => x.quoteType === 'EQUITY' && x.symbol)
          .map(x => ({ symbol: x.symbol, description: x.shortname || x.longname || x.symbol, type: 'Common Stock' })) };
      }
      return ok(put('s:' + q.toLowerCase(), res));
    }
    if (p.hist) {
      const s = String(p.hist).toUpperCase();
      if (!/^[A-Z.\-]{1,10}$/.test(s)) return bad(400, 'symbol');
      const i = Math.max(0, Math.min(5, parseInt(p.p, 10) || 0));
      const ck = 'h:' + s + ':' + i;
      let d = get(ck, 300000);
      if (!d) {
        const r = (await yahooChart(s, RANGES[i][0], RANGES[i][1])).chart.result[0];
        const q = r.indicators.quote[0], t = r.timestamp || [];
        d = [];
        t.forEach((x, k) => {
          const c = q.close[k];
          if (c != null) d.push([x * 1000, q.open[k] ?? c, q.high[k] ?? c, q.low[k] ?? c, c, q.volume[k] || 0]);
        });
        put(ck, d);
      }
      return ok(d);
    }
    const syms = (p.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z.\-]{1,10}$/.test(s)).slice(0, 80);
    if (!syms.length) return bad(400, 'symbols');
    const out = {};
    await pool(syms, 10, async (s) => { out[s] = await quote(s, key); });
    return Object.keys(out).length ? ok(out) : bad(502, 'Aucune source disponible');
  } catch (e) {
    return bad(502, 'Source indisponible');
  }
};
