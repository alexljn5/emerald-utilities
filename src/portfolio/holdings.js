// src/portfolio/holdings.js
//
// Hardcoded current holdings for the Portfolio Monitor page.
// Edit or expand this array to add/remove funds. Each entry is intentionally
// flat and self-describing so it is easy to maintain or replace later.
//
// Fields:
//   id            - stable unique key (used for React keys + chart series)
//   name          - display name
//   isin          - ISIN identifier (used by the data provider to fetch prices)
//   symbol        - exchange ticker used by the financial API (EODHD uses
//                   "<TICKER>.<EXCHANGE>", e.g. "1895.AMS" for Euronext Amsterdam)
//   quantity      - units held
//   avgPrice      - average purchase price per unit (EUR)
//   purchaseValue - quantity * avgPrice (kept explicit for clarity)
//   esg           - ESG composition breakdown (percentages, should sum to 100)
//   esgNote       - optional human readable note about the ESG profile

export const HOLDINGS = [
    {
        id: 'world-index',
        name: '1895 Aandelen Index Wereld Fonds',
        isin: 'NL0014065450',
        symbol: '1895.AMS',
        quantity: 0.1582,
        avgPrice: 189.70,
        purchaseValue: 30.01,
        esg: {
            Environmental: 0,
            Social: 0,
            Governance: 0,
            // The fund does not publish a classic E/S/G split; we surface the
            // sustainability characteristics that are available instead.
            'Low Carbon': 78,
            'Exclusions Applied': 100,
            'ESG Integrated': 100
        },
        esgNote: 'Passive world equity index fund with broad ESG integration and exclusion screening.'
    },
    {
        id: 'euro-bonds',
        name: '1895 Obligaties Index Euro Fonds',
        isin: 'NL0014857104',
        symbol: '1895.AMS',
        quantity: 0.8347,
        avgPrice: 83.86,
        purchaseValue: 70.00,
        esg: {
            Environmental: 0,
            Social: 0,
            Governance: 0,
            'Green Bonds': 22,
            'ESG Filtered': 100,
            'Euro Denominated': 100
        },
        esgNote: 'Passive euro investment-grade bond index fund with ESG filtering.'
    }
];

// Convenience: total purchase value across all holdings.
export const TOTAL_PURCHASE_VALUE = HOLDINGS.reduce(
    (sum, h) => sum + (Number(h.purchaseValue) || 0),
    0
);
