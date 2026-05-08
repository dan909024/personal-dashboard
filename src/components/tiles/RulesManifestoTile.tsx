/**
 * Renders the free-text Rules tab as sectioned headings + bullet lists.
 * Drop into the dashboard with:
 *   import { RulesManifestoTile } from "@/components/tiles/RulesManifestoTile";
 *   <RulesManifestoTile />
 */
import { getRulesManifesto, isConfigured, type ManifestoSection } from "@/lib/sheets";

export async function RulesManifestoTile() {
  if (!isConfigured()) {
    return (
      <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4">
        <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Rules</p>
        <p className="text-xs text-zinc-500 italic mt-2">unconfigured</p>
      </div>
    );
  }

  const manifesto = await getRulesManifesto();

  return (
    <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4 space-y-4">
      <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Rules</p>
      {manifesto.length === 0 ? (
        <p className="text-xs text-zinc-500 italic">
          The Rules tab is empty — add lines in the Sheet to see them here.
        </p>
      ) : (
        manifesto.map((section, i) => <ManifestoBlock key={i} section={section} />)
      )}
    </div>
  );
}

function ManifestoBlock({ section }: { section: ManifestoSection }) {
  const isBulletList =
    section.lines.length > 1 &&
    section.lines.filter((l) => l.startsWith("-")).length >= section.lines.length / 2;
  return (
    <div>
      {section.heading && (
        <p className="text-[11px] font-bold tracking-widest text-zinc-400 uppercase mb-1.5">
          {section.heading}
        </p>
      )}
      {isBulletList ? (
        <ul className="space-y-0.5">
          {section.lines.map((line, i) => (
            <li key={i} className="text-xs text-zinc-300 leading-relaxed">
              {line.replace(/^-\s*/, "• ")}
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-0.5">
          {section.lines.map((line, i) => (
            <p key={i} className="text-xs text-zinc-300 leading-relaxed">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
