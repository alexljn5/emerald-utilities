// src/portfolio/priceProvider.js
//
// Clean, swappable data-fetching layer for the Portfolio Monitor.
//
// The renderer never talks to the financial API directly. Instead it calls an
// IPC handler (`portfolio:fetchQuotes`) which delegates to the active provider
// configured here. This keeps API keys in the main process and makes it trivial
// to swap EODHD for another provider later: implement the same `fetchQuotes`
// shape and change `ACTIVE_PROVIDER` below.
//
// Provider contract:
//   fetchQuotes({ symbols, apiKey }) => Promise<Array<Quote>>
//   Quote = {
//     symbol: string,        // the requested symbol
//     price: number,         // latest close / current price
//     changePercent: number, // daily change in percent (can be 0)
//     currency: string,      // ISO currency code, e.g. "EUR"
//     asOf: string           // ISO timestamp of the quote
//   }

import { eodhdProvider } from './providers/eodhd.js';

// Swap this to change the data source. All providers implement the same
// `fetchQuotes` contract described above.
export const ACTIVE_PROVIDER = eodhdProvider;

/**
 * Fetch quotes for the given symbols using the active provider.
 *
 * @param {Object} params
 * @param {string[]} params.symbols - ticker symbols to fetch
 * @param {string} [params.apiKey]  - API key for the active provider
 * @returns {Promise<Array<{symbol:string,price:number,changePercent:number,currency:string,asOf:string}>>}
 */
export async function fetchQuotes({ symbols = [], apiKey } = {}) {
    if (typeof ACTIVE_PROVIDER?.fetchQuotes !== 'function') {
        throw new Error('No active price provider configured');
    }

    return ACTIVE_PROVIDER.fetchQuotes({ symbols, apiKey });
}

/**
 * Fetch historical end-of-day closes for a symbol (used for the portfolio
 * value-over-time line chart). Falls back to an empty array if unsupported.
 *
 * @param {Object} params
 * @param {string} params.symbol
 * @param {string} [params.apiKey]
 * @param {number} [params.limit=30] - number of most recent trading days
 * @returns {Promise<Array<{date:string, close:number}>>}
 */
export async function fetchHistory({ symbol, apiKey, limit = 30 } = {}) {
    if (typeof ACTIVE_PROVIDER?.fetchHistory !== 'function') {
        return [];
    }

    return ACTIVE_PROVIDER.fetchHistory({ symbol, apiKey, limit });
}
