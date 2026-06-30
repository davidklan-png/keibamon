// ============================================================================
// Refine panel — formerly the standalone "Style" step (ADR-0007 Phase 5).
// Session 3a: Style is no longer a step. Its controls (personality grid +
// budget/unit + advanced complexity/flavor) now live inline on the Tickets
// screen inside a collapsible "Refine ▾" panel. Same `style` state, same
// onChange (App still owns `style`; auto-regenerate fires on change as before).
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

export interface RefinePanelProps {
  style: StyleState;
  onChange: (s: StyleState) => void;
  /** Optional: start the panel expanded (defaults to collapsed). */
  defaultOpen?: boolean;
}

/**
 * Inline "Refine ▾" panel for the Tickets screen. Renders as a
 * `<details className="refine">` (matching the codebase's existing details
 * idiom) holding the personality picker, budget/unit, and the advanced
 * complexity/flavor knobs. Editing any control calls onChange; the parent's
 * auto-regenerate effect reshapes the ticket set in place.
 */
export function RefinePanel(props: RefinePanelProps) {
  const { t } = useI18n();
  const { style, onChange, defaultOpen } = props;
  return (
    <details className="refine" open={defaultOpen}>
      <summary>{t("refine.summary")}</summary>

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
    </details>
  );
}
