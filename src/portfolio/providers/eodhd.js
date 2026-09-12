// src/portfolio/providers/eodhd.js
//
// EODHD (https://eodhd.com) price provider.
//
// EODHD is a freemium financial data API. The free/demo tier allows a limited
// number of requests and some endpoints require a paid key, but the real-time
// and end-of-day endpoints are suitable for personal use.
//
// Endpoints used:
//   - Real-time quote:  https://eodhd.com/api/real-time/<SYMBOL>?api_token=<KEY>&fmt=json
//   - End-of-day:       https://eodhd.com/api/eod/<SYMBOL>?api_token=<KEY>&fmt=json&limit=<N>
//
// The provider is intentionally thin: it only maps the EODHD response into the
// generic Quote shape used by priceProvider.js. To use another vendor, create a
// sibling file implementing the same `fetchQuotes` / `fetchHistory` contract.

const EODHD_BASE = 'https://eodhd.com/api';

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch real-time / latest quotes for one or more symbols.
 *
 * @param {Object} params
 * @param {string[]} params.symbols
 * @param {string} [params.apiKey]
 * @returns {Promise<Array<{symbol:string,price:number,changePercent:number,currency:string,asOf:string}>>}
 */
export async function fetchQuotes({ symbols = [], apiKey } = {}) {
    if (!apiKey) {
        throw new Error('EODHD API key is missing. Set EODHD_API_KEY in your config or environment.');
    }

    // Fetch each symbol independently so one bad ticker doesn't crash the
    // entire portfolio. Failed symbols are returned with price=0 and an
    // error flag so the UI can show "unavailable" instead of blank.
    const results = await Promise.all(
        symbols.map(async (symbol) => {
            const url = `${EODHD_BASE}/real-time/${encodeURIComponent(symbol)}?api_token=${encodeURIComponent(apiKey)}&fmt=json`;

            try {
                const response = await fetch(url);

                if (response.status === 404) {
                    console.warn(`[EODHD] Quote not found for ${symbol} (404). Marking as unavailable.`);
                    return {
                        symbol,
                        price: 0,
                        changePercent: 0,
                        currency: 'EUR',
                        asOf: new Date().toISOString(),
                        unavailable: true,
                        error: 'Symbol not found'
                    };
                }

                if (!response.ok) {
                    throw new Error(`EODHD request failed for ${symbol} (${response.status})`);
                }

                const data = await response.json();

                // EODHD real-time payload fields:
                //   close, previousClose, change_p, code (symbol), timestamp, currency
                const previousClose = toNumber(data.previousClose);
                const close = toNumber(data.close);
                const changePercent = Number.isFinite(Number(data.change_p))
                    ? Number(data.change_p)
                    : (previousClose > 0 ? ((close - previousClose) / previousClose) * 100 : 0);

                return {
                    symbol: data.code || symbol,
                    price: close,
                    changePercent,
                    currency: data.currency || 'EUR',
                    asOf: data.timestamp
                        ? new Date(toNumber(data.timestamp) * 1000).toISOString()
                        : new Date().toISOString()
                };
            } catch (err) {
                console.error(`[EODHD] Quote fetch failed for ${symbol}:`, err.message);
                return {
                    symbol,
                    price: 0,
                    changePercent: 0,
                    currency: 'EUR',
                    asOf: new Date().toISOString(),
                    unavailable: true,
                    error: err.message
                };
            }
        })
    );

    return results;
}

/**
 * Fetch historical end-of-day closes for a single symbol.
 *
 * @param {Object} params
 * @param {string} params.symbol
 * @param {string} [params.apiKey]
 * @param {number} [params.limit]
 * @returns {Promise<Array<{date:string, close:number}>>}
 */
export async function fetchHistory({ symbol, apiKey, limit = 30 } = {}) {
    if (!apiKey || !symbol) {
        return [];
    }

    const url = `${EODHD_BASE}/eod/${encodeURIComponent(symbol)}?api_token=${encodeURIComponent(apiKey)}&fmt=json&limit=${Number(limit) || 30}`;

    const response = await fetch(url);

    // 404 = symbol not found / delisted / unsupported. Return empty array
    // so the portfolio monitor can continue processing other holdings.
    if (response.status === 404) {
        console.warn(`[EODHD] History not available for ${symbol} (404). Skipping.`);
        return [];
    }

    if (!response.ok) {
        throw new Error(`EODHD history request failed for ${symbol} (${response.status})`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
        return [];
    }

    // EODHD returns newest-first; reverse to chronological order.
    return data
        .slice()
        .reverse()
        .map((row) => ({
            date: row.date,
            close: toNumber(row.close)
        }));
}

export const eodhdProvider = {
    name: 'eodhd',
    fetchQuotes,
    fetchHistory
};
