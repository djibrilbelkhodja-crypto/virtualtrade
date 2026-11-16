// Relais Finnhub : la clé reste cachée côté serveur (variable FINNHUB_KEY).
const cache = {};
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30, s-maxage=60' };

exports.handler = async (event) => {
  const key = process.env.FINNHUB_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: 'FINNHUB_KEY manquante' }) };
  const p = event.queryStringParameters || {};
  try {
    if (p.q) {
      const q = String(p.q).slice(0, 40);
      const r = await fetch('https://finnhub.io/api/v1/search?q=' + encodeURIComponent(q) + '&token=' + key);
      return { statusCode: r.status, headers: H, body: await r.text() };
    }
    const syms = (p.symbols || '').split(',').map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z.\-]{1,10}$/.test(s)).slice(0, 60);
    const now = Date.now(), out = {};
    await Promise.all(syms.map(async s => {
      const c = cache[s];
      if (c && now - c.t < 60000) { out[s] = c.d; return; }
      try {
        const r = await fetch('https://finnhub.io/api/v1/quote?symbol=' + s + '&token=' + key);
        if (r.ok) { const d = await r.json(); cache[s] = { t: now, d }; out[s] = d; }
        else if (c) out[s] = c.d;
      } catch (e) { if (c) out[s] = c.d; }
    }));
    return { statusCode: 200, headers: H, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Finnhub indisponible' }) };
  }
};
