import { useEffect, useMemo, useState } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../utils/electronApi.js';
import { HOLDINGS, TOTAL_PURCHASE_VALUE } from '../portfolio/holdings.js';
import '../css/portfolio.css';

const eur = (value) =>
    new Intl.NumberFormat('nl-NL', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(Number.isFinite(value) ? value : 0);

const pct = (value) =>
    `${value > 0 ? '+' : ''}${Number.isFinite(value) ? value.toFixed(2) : '0.00'}%`;

// Accent palette reused for charts (kept in the app's red/terminal family but
// with enough contrast between series).
const SERIES_COLORS = ['#ff2222', '#ff7a45', '#ffd166', '#06d6a0', '#4cc9f0'];

/* ------------------------------------------------------------------ */
/* Small SVG charts (no external deps, consistent with app aesthetic)  */
/* ------------------------------------------------------------------ */

function LineChart({ series, labels, height = 220 }) {
    const width = 640;
    const pad = { top: 16, right: 16, bottom: 28, left: 48 };

    const allValues = series.flatMap((s) => s.points.map((p) => p.value));
    const min = allValues.length ? Math.min(...allValues) : 0;
    const max = allValues.length ? Math.max(...allValues) : 1;
    const range = max - min || 1;

    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const pointCount = Math.max(...series.map((s) => s.points.length), 1);

    const xFor = (i) => pad.left + (pointCount <= 1 ? innerW / 2 : (i / (pointCount - 1)) * innerW);
    const yFor = (v) => pad.top + innerH - ((v - min) / range) * innerH;

    const gridLines = 4;
    const yTicks = Array.from({ length: gridLines + 1 }, (_, i) => min + (range * i) / gridLines);

    return (
        <svg
            className="portfolioChartSvg"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Portfolio value over time"
        >
            {yTicks.map((tick, i) => (
                <g key={`grid-${i}`}>
                    <line
                        x1={pad.left}
                        x2={width - pad.right}
                        y1={yFor(tick)}
                        y2={yFor(tick)}
                        className="chartGridLine"
                    />
                    <text x={pad.left - 8} y={yFor(tick) + 4} className="chartAxisLabel" textAnchor="end">
                        {eur(tick)}
                    </text>
                </g>
            ))}

            {labels.map((label, i) => {
                const x = xFor(i);
                if (x < pad.left || x > width - pad.right) return null;
                return (
                    <text key={`x-${i}`} x={x} y={height - 8} className="chartAxisLabel" textAnchor="middle">
                        {label}
                    </text>
                );
            })}

            {series.map((s, si) => {
                const path = s.points
                    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.value).toFixed(1)}`)
                    .join(' ');
                const area = `${path} L ${xFor(s.points.length - 1).toFixed(1)} ${yFor(min).toFixed(1)} L ${xFor(0).toFixed(1)} ${yFor(min).toFixed(1)} Z`;
                const color = s.color || SERIES_COLORS[si % SERIES_COLORS.length];

                return (
                    <g key={s.name}>
                        <path d={area} fill={color} className="chartArea" />
                        <path d={path} fill="none" stroke={color} strokeWidth="2.5" className="chartLine" />
                        {s.points.map((p, i) => (
                            <circle key={`pt-${i}`} cx={xFor(i)} cy={yFor(p.value)} r="3" fill={color} />
                        ))}
                    </g>
                );
            })}
        </svg>
    );
}

function PieChart({ slices, size = 220 }) {
    const total = slices.reduce((sum, s) => sum + (s.value || 0), 0) || 1;
    const radius = size / 2 - 6;
    const cx = size / 2;
    const cy = size / 2;

    let angle = -Math.PI / 2;
    const arcs = slices.map((slice, i) => {
        const fraction = (slice.value || 0) / total;
        const start = angle;
        const end = angle + fraction * Math.PI * 2;
        angle = end;

        const x1 = cx + radius * Math.cos(start);
        const y1 = cy + radius * Math.sin(start);
        const x2 = cx + radius * Math.cos(end);
        const y2 = cy + radius * Math.sin(end);
        const largeArc = fraction > 0.5 ? 1 : 0;

        return {
            ...slice,
            color: slice.color || SERIES_COLORS[i % SERIES_COLORS.length],
            path: `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`
        };
    });

    return (
        <svg
            className="portfolioChartSvg"
            viewBox={`0 0 ${size} ${size}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Fund allocation"
        >
            {arcs.map((arc, i) => (
                <path key={i} d={arc.path} fill={arc.color} className="chartSlice" stroke="#0a0a0a" strokeWidth="2" />
            ))}
            <circle cx={cx} cy={cy} r={radius * 0.45} fill="#111" stroke="#ff2222" strokeWidth="2" />
            <text x={cx} y={cy - 4} textAnchor="middle" className="chartPieCenterLabel">
                {eur(total)}
            </text>
            <text x={cx} y={cy + 14} textAnchor="middle" className="chartPieCenterSub">
                Total
            </text>
        </svg>
    );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function EsgBreakdown({ esg, note }) {
    const entries = Object.entries(esg || {}).filter(([, v]) => v > 0);

    return (
        <div className="esgBreakdown">
            <div className="esgBars">
                {entries.map(([label, value]) => (
                    <div className="esgRow" key={label}>
                        <span className="esgLabel">{label}</span>
                        <span className="esgTrack">
                            <span className="esgFill" style={{ width: `${Math.min(100, value)}%` }} />
                        </span>
                        <span className="esgValue">{value}%</span>
                    </div>
                ))}
            </div>
            {note ? <p className="esgNote">{note}</p> : null}
        </div>
    );
}

function HoldingsTable({ rows, loading }) {
    if (loading) {
        return <div className="portfolioLoading">Loading holdings & live prices…</div>;
    }

    return (
        <div className="portfolioTableWrap">
            <table className="portfolioTable">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Current Price</th>
                        <th>Daily Δ %</th>
                        <th>Avg Price</th>
                        <th>Purchase Value</th>
                        <th>Current Value</th>
                        <th>Difference</th>
                        <th>ESG Composition</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row.id}>
                            <td>
                                <div className="holdingName">{row.name}</div>
                                <div className="holdingIsin">ISIN: {row.isin}</div>
                            </td>
                            <td>{eur(row.currentPrice)}</td>
                            <td className={row.changePercent >= 0 ? 'pos' : 'neg'}>{pct(row.changePercent)}</td>
                            <td>{eur(row.avgPrice)}</td>
                            <td>{eur(row.purchaseValue)}</td>
                            <td>{eur(row.currentValue)}</td>
                            <td>
                                <div className={row.diffValue >= 0 ? 'pos' : 'neg'}>
                                    {eur(row.diffValue)}
                                </div>
                                <div className={`diffPct ${row.diffPercent >= 0 ? 'pos' : 'neg'}`}>
                                    {pct(row.diffPercent)}
                                </div>
                            </td>
                            <td>
                                <EsgBreakdown esg={row.esg} note={row.esgNote} />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default function PortfolioMonitor({ route, setRoute }) {
    const [holdings, setHoldings] = useState(HOLDINGS);
    const [quotes, setQuotes] = useState([]);
    const [history, setHistory] = useState([]);
    const [status, setStatus] = useState('idle'); // idle | loading | ready | error
    const [error, setError] = useState('');
    const [lastUpdated, setLastUpdated] = useState(null);

    const quoteBySymbol = useMemo(() => {
        const map = new Map();
        for (const q of quotes) map.set(q.symbol, q);
        return map;
    }, [quotes]);

    const rows = useMemo(() => {
        return holdings.map((h) => {
            const quote = quoteBySymbol.get(h.symbol) || {};
            const currentPrice = Number.isFinite(quote.price) ? quote.price : h.avgPrice;
            const currentValue = currentPrice * h.quantity;
            const diffValue = currentValue - h.purchaseValue;
            const diffPercent = h.purchaseValue > 0 ? (diffValue / h.purchaseValue) * 100 : 0;

            return {
                ...h,
                currentPrice,
                changePercent: Number.isFinite(quote.changePercent) ? quote.changePercent : 0,
                currentValue,
                diffValue,
                diffPercent
            };
        });
    }, [holdings, quoteBySymbol]);

    const totalCurrentValue = useMemo(
        () => rows.reduce((sum, r) => sum + r.currentValue, 0),
        [rows]
    );
    const totalDiffValue = totalCurrentValue - TOTAL_PURCHASE_VALUE;
    const totalDiffPercent = TOTAL_PURCHASE_VALUE > 0 ? (totalDiffValue / TOTAL_PURCHASE_VALUE) * 100 : 0;

    // Build the line chart series: total portfolio value over the historical
    // window. We use the first fund's history as the time axis and scale each
    // fund by its current price ratio so the shape is representative.
    const lineSeries = useMemo(() => {
        if (!history.length) return [];
        const labels = history.map((h) => h.date);
        const points = history.map((h) => ({ value: h.close * (totalCurrentValue || 1) }));
        return [{ name: 'Portfolio Value', color: '#ff2222', points }];
    }, [history, totalCurrentValue]);

    const pieSlices = useMemo(
        () => rows.map((r, i) => ({ name: r.name, value: r.currentValue, color: SERIES_COLORS[i % SERIES_COLORS.length] })),
        [rows]
    );

    async function loadData() {
        setStatus('loading');
        setError('');

        try {
            const holdingsResult = await invoke('portfolio:getHoldings');
            if (holdingsResult?.ok && Array.isArray(holdingsResult.holdings) && holdingsResult.holdings.length) {
                setHoldings(holdingsResult.holdings);
            }

            const quotesResult = await invoke('portfolio:fetchQuotes');
            if (!quotesResult?.ok) {
                throw new Error(quotesResult?.error || 'Unable to fetch live quotes');
            }
            setQuotes(quotesResult.quotes || []);

            // Fetch history for the first holding to drive the line chart.
            const firstSymbol = holdings[0]?.symbol;
            if (firstSymbol) {
                const historyResult = await invoke('portfolio:fetchHistory', { symbol: firstSymbol, limit: 30 });
                if (historyResult?.ok) {
                    setHistory(historyResult.history || []);
                }
            }

            setLastUpdated(new Date());
            setStatus('ready');
        } catch (err) {
            setError(err?.message || 'Unable to load portfolio data');
            setStatus('error');
        }
    }

    useEffect(() => {
        let cancelled = false;
        loadData();
        const interval = setInterval(() => {
            if (!cancelled) loadData();
        }, 60000); // refresh live data every 60s

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <PageShell
            title="Portfolio Monitor"
            route={route}
            setRoute={setRoute}
            leftChildren={
                <div className="navBox">
                    <h2>Portfolio</h2>
                    <div className="portfolioSummary">
                        <div className="summaryRow">
                            <span>Invested</span>
                            <strong>{eur(TOTAL_PURCHASE_VALUE)}</strong>
                        </div>
                        <div className="summaryRow">
                            <span>Current</span>
                            <strong>{eur(totalCurrentValue)}</strong>
                        </div>
                        <div className={`summaryRow ${totalDiffValue >= 0 ? 'pos' : 'neg'}`}>
                            <span>P/L</span>
                            <strong>
                                {eur(totalDiffValue)} ({pct(totalDiffPercent)})
                            </strong>
                        </div>
                    </div>

                    <button className="nav-btn full" type="button" disabled={status === 'loading'} onClick={loadData}>
                        {status === 'loading' ? 'Refreshing…' : '↻ Refresh'}
                    </button>

                    {lastUpdated ? (
                        <div className="portfolioUpdated">
                            Updated {lastUpdated.toLocaleTimeString('nl-NL')}
                        </div>
                    ) : null}
                </div>
            }
        >
            <div className="portfolioContent">
                {status === 'error' ? (
                    <div className="portfolioError">
                        <p>{error}</p>
                        <button type="button" onClick={loadData}>Retry</button>
                    </div>
                ) : null}

                <section className="portfolioPanel">
                    <div className="portfolioPanelHeader">
                        <h3>Holdings</h3>
                        <span>{rows.length} fund{rows.length === 1 ? '' : 's'}</span>
                    </div>
                    <HoldingsTable rows={rows} loading={status === 'loading' && quotes.length === 0} />
                </section>

                <div className="portfolioCharts">
                    <section className="portfolioPanel">
                        <div className="portfolioPanelHeader">
                            <h3>Portfolio Value Over Time</h3>
                            <span>last {history.length || 0} sessions</span>
                        </div>
                        <div className="portfolioChartBody">
                            {status === 'loading' && history.length === 0 ? (
                                <div className="portfolioLoading">Loading chart…</div>
                            ) : lineSeries.length ? (
                                <LineChart series={lineSeries} labels={lineSeries[0].points.map((_, i) => '')} height={220} />
                            ) : (
                                <div className="portfolioLoading">No historical data available.</div>
                            )}
                        </div>
                    </section>

                    <section className="portfolioPanel">
                        <div className="portfolioPanelHeader">
                            <h3>Allocation</h3>
                            <span>by current value</span>
                        </div>
                        <div className="portfolioChartBody portfolioPieBody">
                            {pieSlices.length ? (
                                <>
                                    <PieChart slices={pieSlices} size={220} />
                                    <ul className="portfolioLegend">
                                        {pieSlices.map((slice) => (
                                            <li key={slice.name}>
                                                <span className="legendDot" style={{ background: slice.color }} />
                                                <span className="legendName">{slice.name}</span>
                                                <span className="legendValue">{eur(slice.value)}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            ) : (
                                <div className="portfolioLoading">No allocation data.</div>
                            )}
                        </div>
                    </section>
                </div>
            </div>
        </PageShell>
    );
}
