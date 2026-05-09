"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { WeaknessSeriesPoint } from "@/lib/weakness";

const PURPLE = "#a855f7";

export function WeaknessChart({ data }: { data: WeaknessSeriesPoint[] }) {
  if (!data || data.length === 0 || data.every((p) => p.weakness === 0)) {
    return (
      <p className="text-xs text-zinc-500 italic px-1">
        Curve will populate as data is logged.
      </p>
    );
  }

  const formatted = data.map((p) => ({
    ...p,
    label: p.date.slice(5), // MM-DD
  }));

  return (
    <div className="w-full h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={formatted} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" />
          <XAxis
            dataKey="label"
            stroke="#52525b"
            tick={{ fontSize: 10, fill: "#71717a" }}
            interval={Math.max(0, Math.floor(formatted.length / 6) - 1)}
          />
          <YAxis
            stroke="#52525b"
            tick={{ fontSize: 10, fill: "#71717a" }}
            width={40}
            domain={[0, "auto"]}
          />
          <Tooltip
            contentStyle={{
              background: "#0f0f0f",
              border: "1px solid #2a2a2a",
              borderRadius: 4,
              color: "#e5e5e5",
              fontSize: 12,
            }}
            labelStyle={{ color: "#a1a1aa" }}
            formatter={(value, name, item) => {
              if (name === "weakness") {
                const p = (item as { payload?: WeaknessSeriesPoint } | undefined)?.payload;
                const label =
                  p?.slipMarker === "peak" ? "Weakness (pre-slip peak)" : "Weakness";
                return [
                  `${value} (edges: ${p?.edges ?? 0}, phase: ${p?.phase ?? "—"})`,
                  label,
                ];
              }
              return [value as number | string, name as string];
            }}
            labelFormatter={(label, payload) => {
              const items = payload as unknown as ReadonlyArray<{ payload?: WeaknessSeriesPoint }> | undefined;
              const point = items?.[0]?.payload;
              return point?.date ?? (label as string);
            }}
          />
          <Line
            type="monotone"
            dataKey="weakness"
            stroke={PURPLE}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: PURPLE }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
