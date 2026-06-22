// ============================================================================
// Style Screen — extracted from App.tsx (ADR-0007 Phase 5).
// Behavior-preserving move. Personality picker (ADR-0005) + budget/unit +
// advanced complexity/flavor knobs.
// ============================================================================
import { useI18n } from "../i18n";
import type {
  StyleState,
  PersonalityId,
  Complexity,
  Flavor,
} from "../lib/types";
import { applyPersonality } from "../lib/types";

const PERSONALITIES: PersonalityId[] = [
  "safe",
  "balanced",
  "longshot",
  "fan",
  "antiChalk",
];

const COMPLEXITIES: Complexity[] = ["auto", "two", "three", "straight"];
const FLAVORS: Flavor[] = ["mixed", "chalk", "value"];

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface StyleScreenProps {
  style: StyleState;
  onChange: (s: StyleState) => void;
  onBack: () => void;
  onSeeTickets: () => void;
}

export function StyleScreen(props: StyleScreenProps) {
  const { t } = useI18n();
  const { style, onChange, onBack, onSeeTickets } = props;
  return (
    <>
      <section className="section">
        <div className="section-title">
          <h2>{t("style.title")}</h2>
          <small>{t("style.hint")}</small>
        </div>
        {/* ADR-0005: personality is the ONE "how you play" control. Picking it
            derives flavor + complexity (Advanced lets power users override). */}
        <div className="persona-grid">
          {PERSONALITIES.map((id) => (
            <button
              key={id}
              className={`persona ${style.personality === id ? "on" : ""}`}
              onClick={() => onChange(applyPersonality(style, id))}
            >
              <div className="pname">{t(`personality.${id}.name`)}</div>
              <div className="pdesc">{t(`personality.${id}.desc`)}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="grid-2">
          <div className="field">
            <label>{t("style.budget")} (¥)</label>
            <input
              type="number"
              min={100}
              step={100}
              value={style.budget}
              onChange={(e) =>
                onChange({ ...style, budget: Math.max(100, +e.target.value || 0) })
              }
            />
          </div>
          <div className="field">
            <label>{t("style.unit")} (¥)</label>
            <input
              type="number"
              min={100}
              step={100}
              value={style.unit}
              onChange={(e) =>
                onChange({ ...style, unit: Math.max(100, +e.target.value || 0) })
              }
            />
          </div>
        </div>
        {/* Advanced: the raw knobs personality now sets for you. Kept, not deleted. */}
        <details className="advanced">
          <summary>{t("style.advanced")}</summary>
          <div className="grid-2" style={{ marginTop: 10 }}>
            <div className="field">
              <label>{t("style.complexity")}</label>
              <select
                value={style.complexity}
                onChange={(e) =>
                  onChange({ ...style, complexity: e.target.value as Complexity })
                }
              >
                {COMPLEXITIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`style.complexity${cap(c)}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t("style.flavor")}</label>
              <select
                value={style.flavor}
                onChange={(e) =>
                  onChange({ ...style, flavor: e.target.value as Flavor })
                }
              >
                {FLAVORS.map((f) => (
                  <option key={f} value={f}>
                    {t(`style.flavor${cap(f)}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </details>
      </section>

      <button
        className="btn primary"
        style={{ width: "100%" }}
        onClick={onSeeTickets}
      >
        {t("tickets.title")} →
      </button>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn ghost" onClick={onBack}>
          ← {t("nav.race")}
        </button>
      </div>
    </>
  );
}
