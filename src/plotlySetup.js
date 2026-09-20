// Vendored Plotly (docs/specs/41-dependency-ordering-density.md,
// Commit 1) — replaces the CDN <script src="https://cdn.plot.ly/...">
// index.html used to load. Every chart call site in this app
// (chart.js, main.js) references the bare global `Plotly`, exactly as
// the CDN script also provided it; assigning it here, once, before any
// of that code runs, keeps every one of those call sites unchanged —
// the whole point of this commit is that nothing about rendering
// changes.
//
// plotly.js-finance-dist-min, not the full ~4.5MB bundle, pinned to
// 2.35.2 (the exact version the CDN tag pinned). This app's own trace
// usage — confirmed by grepping every Plotly.react/newPlot call site
// across chart.js and main.js, including the disabled legacy insight
// modules (drawdownTolerance.js, firstDecade.js) — is exactly
// `scatter`, `bar` and `waterfall`. Plotly's own `basic` partial
// bundle covers scatter and bar but not waterfall; `finance` is the
// smallest of Plotly's published bundles that covers all three
// (it also carries candlestick/ohlc/funnel/indicator/histogram/pie,
// unused here but unavoidable at this granularity) — 1.17MB unpacked
// against the full bundle's 4.56MB, a ~74% reduction, not a small one.
import Plotly from "plotly.js-finance-dist-min";

window.Plotly = Plotly;
