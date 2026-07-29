import { AlertTriangle, BarChart3, CircleAlert, Info, TrendingUp } from "lucide-react";

import type { AnalyticsChart, AnalyticsPayload } from "./analysis";

const palette = ["#c74b58", "#d99a55", "#6ca6cd", "#78b893"];

function formatValue(value: number) {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (magnitude >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(magnitude < 10 ? 2 : 1);
}

function chartGeometry(chart: AnalyticsChart) {
  const values = chart.data.flatMap((point) => chart.series.map((series) => point.values[series.key])).filter((value): value is number => typeof value === "number");
  const min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (max === min) max = min + 1;
  return { min, max, span: max - min };
}

function Chart({ chart }: { chart: AnalyticsChart }) {
  const width = Math.max(680, chart.data.length * (chart.type === "bar" ? 74 : 58));
  const height = 310;
  const margin = { top: 22, right: 24, bottom: 62, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const { min, max, span } = chartGeometry(chart);
  const x = (index: number) => margin.left + (chart.data.length === 1 ? plotWidth / 2 : (index / (chart.data.length - 1)) * plotWidth);
  const y = (value: number) => margin.top + ((max - value) / span) * plotHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => min + (span * index) / 4).reverse();
  const labelEvery = Math.max(1, Math.ceil(chart.data.length / 7));
  const baseline = y(Math.max(min, Math.min(0, max)));

  return <section className="analytics-chart-card">
    <header><div><h4>{chart.title}</h4>{chart.subtitle && <p>{chart.subtitle}</p>}</div><BarChart3 size={18} /></header>
    <div className="chart-legend" aria-label="Chart legend">{chart.series.map((series, index) => <span key={series.key}><i style={{ background: palette[index] }} />{series.label}</span>)}</div>
    <div className="chart-scroll">
      <svg className="analytics-chart" viewBox={`0 0 ${width} ${height}`} style={{ width }} role="img" aria-label={chart.title}>
        {ticks.map((tick) => <g key={tick}>
          <line x1={margin.left} y1={y(tick)} x2={width - margin.right} y2={y(tick)} className="chart-gridline" />
          <text x={margin.left - 10} y={y(tick) + 4} textAnchor="end" className="chart-axis-label">{formatValue(tick)}</text>
        </g>)}
        {chart.yLabel && <text x={15} y={margin.top + plotHeight / 2} textAnchor="middle" transform={`rotate(-90 15 ${margin.top + plotHeight / 2})`} className="chart-axis-title">{chart.yLabel}</text>}

        {chart.type === "line" && chart.series.map((series, seriesIndex) => {
          let path = "";
          chart.data.forEach((point, pointIndex) => {
            const value = point.values[series.key];
            if (typeof value !== "number") return;
            const previous = pointIndex > 0 ? chart.data[pointIndex - 1].values[series.key] : null;
            path += `${typeof previous === "number" ? "L" : "M"}${x(pointIndex)},${y(value)} `;
          });
          return <g key={series.key}>
            <path d={path} fill="none" stroke={palette[seriesIndex]} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            {chart.data.map((point, pointIndex) => {
              const value = point.values[series.key];
              if (typeof value !== "number") return null;
              return <g key={`${series.key}-${pointIndex}`}>
                {point.anomaly && <circle cx={x(pointIndex)} cy={y(value)} r="9" className="chart-anomaly-halo" />}
                <circle cx={x(pointIndex)} cy={y(value)} r="4" fill={palette[seriesIndex]} className="chart-point"><title>{`${point.label} · ${series.label}: ${formatValue(value)}`}</title></circle>
              </g>;
            })}
          </g>;
        })}

        {chart.type === "bar" && chart.data.flatMap((point, pointIndex) => {
          const groupWidth = Math.min(52, plotWidth / Math.max(chart.data.length, 1) * .72);
          const barWidth = groupWidth / chart.series.length;
          const center = chart.data.length === 1 ? x(pointIndex) : margin.left + (pointIndex + .5) * (plotWidth / chart.data.length);
          return chart.series.map((series, seriesIndex) => {
            const value = point.values[series.key];
            if (typeof value !== "number") return null;
            const valueY = y(value);
            const rectY = Math.min(valueY, baseline);
            const rectHeight = Math.max(1, Math.abs(baseline - valueY));
            return <rect key={`${series.key}-${pointIndex}`} x={center - groupWidth / 2 + seriesIndex * barWidth} y={rectY} width={Math.max(2, barWidth - 2)} height={rectHeight} rx="3" fill={palette[seriesIndex]} className={point.anomaly ? "chart-bar anomaly" : "chart-bar"}><title>{`${point.label} · ${series.label}: ${formatValue(value)}`}</title></rect>;
          });
        })}

        {chart.data.map((point, index) => index % labelEvery === 0 || index === chart.data.length - 1 ? <text key={`${point.label}-${index}`} x={chart.type === "bar" ? margin.left + (index + .5) * (plotWidth / chart.data.length) : x(index)} y={height - 34} textAnchor="middle" className="chart-x-label">{point.label.length > 18 ? `${point.label.slice(0, 17)}…` : point.label}</text> : null)}
      </svg>
    </div>
  </section>;
}

function AnomalyIcon({ severity }: { severity: AnalyticsPayload["anomalies"][number]["severity"] }) {
  if (severity === "critical") return <CircleAlert size={18} />;
  if (severity === "warning") return <AlertTriangle size={18} />;
  return <Info size={18} />;
}

export function AnalyticsPanel({ analysis }: { analysis: AnalyticsPayload }) {
  const hasContent = analysis.kpis.length || analysis.charts.length || analysis.anomalies.length || analysis.notes.length;
  if (!hasContent) return null;
  return <div className="analytics-panel">
    {analysis.period && <div className="analytics-period"><TrendingUp size={15} /><span>{analysis.period.label}</span><small>{analysis.period.start} – {analysis.period.end}</small></div>}
    {!!analysis.kpis.length && <div className="kpi-grid">{analysis.kpis.map((kpi, index) => <div className={`kpi-card ${kpi.status}`} key={`${kpi.label}-${index}`}><small>{kpi.label}</small><strong>{kpi.value}<span>{kpi.unit}</span></strong></div>)}</div>}
    {!!analysis.charts.length && <div className="analytics-charts">{analysis.charts.map((chart, index) => <Chart chart={chart} key={`${chart.title}-${index}`} />)}</div>}
    {!!analysis.anomalies.length && <section className="anomaly-section"><header><AlertTriangle size={17} /><h4>What needs attention</h4></header><div className="anomaly-list">{analysis.anomalies.map((anomaly, index) => <article className={`anomaly-card ${anomaly.severity}`} key={`${anomaly.title}-${index}`}><AnomalyIcon severity={anomaly.severity} /><div><strong>{anomaly.title}</strong><p>{anomaly.detail}</p></div></article>)}</div></section>}
    {!!analysis.notes.length && <ul className="analytics-notes">{analysis.notes.map((note, index) => <li key={`${note}-${index}`}>{note}</li>)}</ul>}
  </div>;
}
