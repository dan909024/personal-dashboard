/**
 * /tools/test-nutrition — manual POST to /api/health/ingest so you can
 * verify the protein/calories/water pipeline is wired up before you
 * touch the iOS Shortcut. Server action reads the auth secret from env
 * and calls the route, so the page itself doesn't expose anything.
 *
 * No auth on the page — URL is unguessable enough for a personal
 * project. Don't link to it from the main dashboard nav.
 */
import Link from "next/link";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type IngestResult =
  | { ok: true; status: number; body: string }
  | { ok: false; status: number; error: string; body?: string };

async function submitTest(formData: FormData): Promise<IngestResult> {
  "use server";
  const secret = process.env.APPLE_HEALTH_INGEST_SECRET;
  if (!secret) {
    return { ok: false, status: 0, error: "APPLE_HEALTH_INGEST_SECRET not set on server" };
  }

  const sydneyToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const date = String(formData.get("date") || sydneyToday);
  const protein = Number(formData.get("protein") || 0);
  const calories = Number(formData.get("calories") || 0);
  const waterMl = Number(formData.get("water") || 0);

  const payload = {
    date,
    source: "manual-test",
    steps: 0,
    workouts: [],
    ...(protein > 0 ? { protein } : {}),
    ...(calories > 0 ? { caloriesConsumed: calories } : {}),
    ...(waterMl > 0 ? { water: waterMl } : {}),
  };

  // Hit our own route — verifies auth, parsing, and the sheet write
  // through the same code path the Shortcut uses.
  const host =
    process.env.VERCEL_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "http://localhost:3000";
  const base = host.startsWith("http") ? host : `https://${host}`;
  const res = await fetch(`${base}/api/health/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}`, body: text };
  }
  return { ok: true, status: res.status, body: text };
}

export default async function TestNutritionPage({
  searchParams,
}: {
  searchParams?: Promise<{ result?: string; status?: string; ok?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  const result =
    params.result && params.status
      ? {
          ok: params.ok === "1",
          status: Number(params.status),
          body: params.result,
        }
      : null;

  // Server action wrapper that re-renders with the result in URL search
  // params (so refresh doesn't re-submit).
  async function action(formData: FormData) {
    "use server";
    const r = await submitTest(formData);
    const sp = new URLSearchParams({
      result: "ok" in r && r.ok ? r.body : ("body" in r && r.body) || ("error" in r ? r.error : ""),
      status: String(r.status),
      ok: "ok" in r && r.ok ? "1" : "0",
    });
    const { redirect } = await import("next/navigation");
    redirect(`/tools/test-nutrition?${sp.toString()}`);
  }

  const sydneyToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-5">
      <div className="max-w-xl mx-auto">
        <div className="flex items-baseline justify-between mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
            Nutrition ingest — manual test
          </p>
          <Link
            href="/"
            className="text-xs text-zinc-400 hover:text-white transition-colors"
          >
            ← back to dashboard
          </Link>
        </div>

        <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4 mb-4">
          <p className="text-xs text-zinc-400 mb-3">
            Posts a row to the <code className="text-zinc-300">Apple Health</code>{" "}
            sheet via{" "}
            <code className="text-zinc-300">/api/health/ingest</code> with the
            same auth + parsing path the iOS Shortcut uses. Source is set to{" "}
            <code className="text-zinc-300">manual-test</code> so it doesn&apos;t
            collide with your real Shortcut rows. Refresh the dashboard
            after submitting to see the NUTRITION tile pick it up.
          </p>
          <form action={action} className="space-y-3">
            <Field label="Date (YYYY-MM-DD, Sydney)" name="date" defaultValue={sydneyToday} />
            <Field
              label="Protein (g)"
              name="protein"
              type="number"
              step="1"
              min="0"
              placeholder="e.g. 148"
            />
            <Field
              label="Calories consumed (kcal)"
              name="calories"
              type="number"
              step="1"
              min="0"
              placeholder="e.g. 2210"
            />
            <Field
              label="Water (ml)"
              name="water"
              type="number"
              step="50"
              min="0"
              placeholder="e.g. 2400"
            />
            <button
              type="submit"
              className="px-4 py-2 border border-emerald-700 bg-emerald-900/40 text-emerald-200 text-xs uppercase tracking-widest hover:border-emerald-500 hover:bg-emerald-800/60 transition-colors"
            >
              Submit test row
            </button>
          </form>
        </div>

        {result && (
          <div
            className={`border p-4 ${
              result.ok
                ? "border-emerald-900 bg-emerald-950/30"
                : "border-red-900 bg-red-950/30"
            }`}
          >
            <p
              className={`text-[10px] font-bold tracking-widest uppercase mb-2 ${
                result.ok ? "text-emerald-300" : "text-red-300"
              }`}
            >
              {result.ok ? "Success" : "Failed"} · HTTP {result.status}
            </p>
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-words font-mono">
              {result.body || "(empty body)"}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
  step,
  min,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  step?: string;
  min?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-zinc-500 block mb-1">
        {label}
      </span>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        step={step}
        min={min}
        className="w-full bg-[#0a0a0a] border border-[#222] focus:border-zinc-500 outline-none px-3 py-2 text-sm font-mono text-zinc-200"
      />
    </label>
  );
}
