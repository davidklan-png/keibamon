import React from "react";
import { createRoot } from "react-dom/client";
import { Activity, BarChart3, CloudSun, Database, FileText, Gauge } from "lucide-react";
import "./styles.css";

const panels = [
  {
    title: "Data Lake",
    icon: Database,
    items: ["Bronze source snapshots", "Silver canonical tables", "Gold point-in-time features"],
  },
  {
    title: "Signals",
    icon: CloudSun,
    items: ["Body weight deltas", "Travel and recovery", "Weather, news, and analyst notes"],
  },
  {
    title: "Modeling",
    icon: Gauge,
    items: ["Win/top-2/top-3 probabilities", "Walk-forward backtests", "Calibration and SHAP"],
  },
  {
    title: "Research",
    icon: BarChart3,
    items: ["DuckDB marts", "Race and horse drilldowns", "Odds and expected-value overlays"],
  },
];

function App() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Activity size={24} />
          <span>Keibamon</span>
        </div>
        <nav>
          <button className="active" title="Race browser">
            <BarChart3 size={18} />
            <span>Races</span>
          </button>
          <button title="Data assets">
            <Database size={18} />
            <span>Assets</span>
          </button>
          <button title="Briefs">
            <FileText size={18} />
            <span>Briefs</span>
          </button>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Data Platform Overview</h1>
            <p>Local-first racing research, signal ingestion, and ML backtesting.</p>
          </div>
          <button className="primary">Import CSV</button>
        </header>

        <section className="grid">
          {panels.map((panel) => {
            const Icon = panel.icon;
            return (
              <article className="panel" key={panel.title}>
                <div className="panel-title">
                  <Icon size={20} />
                  <h2>{panel.title}</h2>
                </div>
                <ul>
                  {panel.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

