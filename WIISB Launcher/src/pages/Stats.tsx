import { useMemo } from "react";
import { CalendarDays, Clock, Gamepad2, Hourglass, Timer, Trophy } from "lucide-react";
import { useApp } from "@/stores/appStore";
import { useNow } from "@/hooks/hooks";
import { dailySeries, filterByRange, heatmap, summarize, weeklySummary } from "@/utils/stats";
import { formatDuration, formatHours, relativeTime } from "@/utils/format";
import { gameColor } from "@/utils/artwork";
import { isLightTheme } from "@/utils/theme";
import { EmptyState, PageHeader, StatTile } from "@/components/common";
import { ColumnChart, HBarChart, Heatmap } from "@/components/charts";
import { Segmented } from "@/components/ui";
import type { StatsRange } from "@/types";

const RANGES: { value: StatsRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

function Card({ title, subtitle, children, className }: { title: string; subtitle?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`panel p-5 ${className ?? ""}`}>
      <h2 className="display text-lg font-semibold">{title}</h2>
      {subtitle && <p className="mb-3 text-xs text-muted">{subtitle}</p>}
      {!subtitle && <div className="mb-3" />}
      {children}
    </section>
  );
}

export function StatsPage() {
  const games = useApp((s) => s.games);
  const sessions = useApp((s) => s.sessions);
  const settings = useApp((s) => s.settings)!;
  const patch = useApp((s) => s.patchSettings);
  const navigate = useApp((s) => s.navigate);
  const live = sessions.some((s) => s.completionStatus === "active");
  const now = useNow(live, 10000);
  const range = settings.statsRange;
  const light = isLightTheme(settings.theme);

  const inRange = useMemo(() => filterByRange(sessions, range, now), [sessions, range, now]);
  const sum = useMemo(() => summarize(inRange, games, now), [inRange, games, now]);
  const days = useMemo(() => dailySeries(inRange, range, now), [inRange, range, now]);
  const heat = useMemo(() => heatmap(sessions, now, 26), [sessions, now]);
  const week = useMemo(() => weeklySummary(sessions, now), [sessions, now]);
  const title = (slug: string) => games.find((g) => g.slug === slug)?.title ?? slug;
  const color = (slug: string) => gameColor(slug, light);
  const mostPlayed = sum.mostPlayed;
  const lastPlayed = sum.lastPlayed;
  const accent = "var(--c-accent)";

  const header = (
    <PageHeader eyebrow="Real data from your sessions" title="Statistics">
      <Segmented<StatsRange> label="Time range" value={range} options={RANGES} onChange={(v) => void patch({ statsRange: v })} />
    </PageHeader>
  );

  if (sessions.length === 0) {
    return (
      <div className="page-pad">
        {header}
        <div className="panel">
          <EmptyState title="No playtime recorded yet" action={<button className="text-sm font-semibold text-accent2 hover:underline" onClick={() => navigate("library")}>Go to your library →</button>}>
            Statistics are built only from sessions WIISB Launcher actually observes — time starts counting once a game is confirmed running. Nothing here is sample data.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="page-pad space-y-[var(--gap)]">
      {header}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatTile icon={<Timer size={20} />} label="Total playtime" value={formatDuration(sum.totalSecs)} sub={RANGES.find((r) => r.value === range)?.label} />
        <StatTile icon={<Gamepad2 size={20} />} label="Sessions" value={sum.sessionCount} sub={`${sum.completedCount} completed`} />
        <StatTile icon={<Clock size={20} />} label="Average session" value={formatDuration(sum.averageSecs)} />
        <StatTile icon={<Hourglass size={20} />} label="Longest session" value={formatDuration(sum.longestSecs)} />
        <StatTile icon={<Trophy size={20} />} label="Most played" value={mostPlayed ? title(mostPlayed.slug) : "—"} sub={mostPlayed ? formatDuration(mostPlayed.totalSecs) : "No sessions in range"} />
        <StatTile icon={<CalendarDays size={20} />} label="Last played" value={lastPlayed ? title(lastPlayed.slug) : "—"} sub={lastPlayed?.lastPlayedAt ? relativeTime(lastPlayed.lastPlayedAt, now) : undefined} />
      </div>

      {inRange.length === 0 ? (
        <div className="panel">
          <EmptyState compact title="No sessions in this range">Try a longer time range to see your older activity.</EmptyState>
        </div>
      ) : (
        <>
          <div className="grid gap-[var(--gap)] xl:grid-cols-2">
            <Card title="Playtime by game" subtitle="Total recorded time in the selected range">
              <HBarChart
                label="Playtime per game"
                format={formatDuration}
                items={sum.perGame.map((g) => ({ key: g.slug, label: title(g.slug), value: g.totalSecs, color: color(g.slug), detail: `${g.sessionCount} sessions` }))}
              />
            </Card>
            <Card title="Sessions by game" subtitle="How many times each game was played">
              <HBarChart
                label="Sessions per game"
                format={(v) => String(v)}
                items={sum.perGame.map((g) => ({ key: g.slug, label: title(g.slug), value: g.sessionCount, color: color(g.slug) }))}
              />
            </Card>
          </div>

          <div className="grid gap-[var(--gap)] xl:grid-cols-2">
            <Card title="Playtime over time" subtitle="Hours played per day (local time)">
              <ColumnChart
                label="Playtime over time"
                color={accent}
                data={days.map((d) => ({ ...d, value: d.secs }))}
                formatValue={formatDuration}
                formatAxis={(v) => (v === 0 ? "0" : formatHours(v))}
              />
            </Card>
            <Card title="Sessions over time" subtitle="Sessions started per day (local time)">
              <ColumnChart
                label="Sessions over time"
                color={accent}
                data={days.map((d) => ({ ...d, value: d.sessions }))}
                formatValue={(v) => `${v} session${v === 1 ? "" : "s"}`}
                formatAxis={(v) => String(Math.round(v))}
              />
            </Card>
          </div>
        </>
      )}

      <div className="grid gap-[var(--gap)] xl:grid-cols-[1.6fr_1fr]">
        <Card title="Daily activity" subtitle="The last 26 weeks — darker means more playtime that day">
          <Heatmap weeks={heat} format={formatDuration} />
        </Card>
        <Card title="Weekly summary" subtitle="This calendar week vs. last week">
          <div className="display text-4xl font-bold">{formatDuration(week.current)}</div>
          <div className="mt-1 text-[13px] text-muted">
            {week.previous === 0 && week.current === 0
              ? "No play this week or last."
              : week.delta === 0
                ? "Same as last week."
                : `${week.delta > 0 ? "▲" : "▼"} ${formatDuration(Math.abs(week.delta))} ${week.delta > 0 ? "more" : "less"} than last week (${formatDuration(week.previous)})`}
          </div>
        </Card>
      </div>

      <Card title="Details" subtitle="The same numbers as a table">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[13px]">
            <thead className="text-xs uppercase tracking-wider text-muted">
              <tr>
                {["Game", "Playtime", "Sessions", "Average", "Longest", "Last played"].map((h) => (
                  <th key={h} className="pb-2 pr-4 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sum.perGame.map((g) => (
                <tr key={g.slug}>
                  <td className="py-2.5 pr-4 font-semibold"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: color(g.slug) }} />{title(g.slug)}</td>
                  <td className="pr-4 tabular-nums">{formatDuration(g.totalSecs)}</td>
                  <td className="pr-4 tabular-nums">{g.sessionCount}</td>
                  <td className="pr-4 tabular-nums">{g.sessionCount ? formatDuration(g.averageSecs) : "—"}</td>
                  <td className="pr-4 tabular-nums">{g.sessionCount ? formatDuration(g.longestSecs) : "—"}</td>
                  <td className="text-muted">{g.lastPlayedAt ? relativeTime(g.lastPlayedAt, now) : "Never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
