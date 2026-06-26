// ============================================================================
// GlossaryView — bilingual racing glossary browser (Reference → Glossary).
//
// Pure presentational. Renders GLOSSARY_SECTIONS from data/glossary.ts with a
// client-side search (matches English / 日本語 / explanation). Reference
// material only — not betting advice (the subtitle says so).
// ============================================================================
import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { GLOSSARY_SECTIONS } from "../data/glossary";

export function GlossaryView() {
  const { t } = useI18n();
  const [q, setQ] = useState("");

  const query = q.trim().toLowerCase();
  const sections = useMemo(() => {
    if (!query) return GLOSSARY_SECTIONS;
    return GLOSSARY_SECTIONS.map((s) => ({
      ...s,
      terms: s.terms.filter((term) =>
        [term.en, term.ja, term.explanation]
          .join(" ")
          .toLowerCase()
          .includes(query),
      ),
    })).filter((s) => s.terms.length > 0);
  }, [query]);

  const totalShown = sections.reduce((n, s) => n + s.terms.length, 0);

  return (
    <section className="section glossary">
      <div className="section-title">
        <h2>{t("glossary.title")}</h2>
        <small>{t("glossary.subtitle")}</small>
      </div>

      <input
        className="glossary-search"
        type="search"
        placeholder={t("glossary.search")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={t("glossary.search")}
      />

      {totalShown === 0 ? (
        <p className="hint">{t("glossary.noMatch")}</p>
      ) : (
        sections.map((s) => (
          <div className="glossary-block" key={s.id}>
            <h3 className="glossary-block-title">
              {s.titleEn} <span className="ja">{s.titleJa}</span>
            </h3>
            <table className="glossary-table">
              <thead>
                <tr>
                  <th>{t("glossary.columnEn")}</th>
                  <th>{t("glossary.columnJa")}</th>
                  <th>{t("glossary.columnWhat")}</th>
                </tr>
              </thead>
              <tbody>
                {s.terms.map((term) => (
                  <tr key={`${s.id}-${term.en}`}>
                    <td className="en">{term.en}</td>
                    <td className="ja">{term.ja}</td>
                    <td>{term.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </section>
  );
}
