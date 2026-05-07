/**
 * Harley admin page — Goddess control panel.
 *
 * Auth: query string token compared to the HARLEY_ADMIN_TOKEN env var.
 * No cookies, no sessions — Harley bookmarks the URL with the token
 * once. Rotate the token by changing the env var.
 *
 * Reads denial state UNCACHED (readDenialEndDate / getWeaknessSettings)
 * so the page reflects writes immediately, even within the 30s cache TTL
 * the dashboard uses.
 */
import { readDenialEndDate, getWeaknessSettings } from "@/lib/sheets";
import { HarleyForm } from "./HarleyForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function HarleyAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  const token = params.token || "";
  const expected = process.env.HARLEY_ADMIN_TOKEN || "";

  if (!expected) {
    return (
      <Notice
        title="Not configured"
        body={
          <>
            Set <code className="bg-black/30 px-1">HARLEY_ADMIN_TOKEN</code>{" "}
            in Vercel env, then redeploy.
          </>
        }
      />
    );
  }
  if (token !== expected) {
    return <Notice title="Unauthorized" body="Bad or missing token." />;
  }

  const [endDate, settings] = await Promise.all([
    readDenialEndDate(),
    getWeaknessSettings(),
  ]);

  return (
    <HarleyForm
      token={token}
      endDate={endDate}
      allowed={settings.orgasm_allowed}
    />
  );
}

function Notice({
  title,
  body,
}: {
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-black text-zinc-300 flex items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <p className="text-[10px] font-bold tracking-widest text-rose-400 uppercase mb-2">
          {title}
        </p>
        <p className="text-sm">{body}</p>
      </div>
    </div>
  );
}
