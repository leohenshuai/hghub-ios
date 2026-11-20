import { useEffect, useMemo, useState } from "react";
import { IBack, IRefresh } from "../icons";
import { pluginError } from "./client";
import { usePluginRequests } from "./usePluginRequests";

type Ev = { at: number; kind: "call" | "event"; plugin: string; name?: string; version?: string; method?: string; ms?: number; ok?: boolean; code?: string; message?: string; level?: string; params?: Record<string, unknown>; warnings?: number };
type MethodStat = { method: string; calls: number; errors: number; avgMs: number; maxMs: number };
type Sum = { plugin: string; name: string; version?: string; calls: number; errors: number; faults: number; playFailures?: number; plays?: number; avgMs: number; maxMs: number; lastAt: number; codes: Record<string, number>; lastError?: { at: number; code: string; message: string; method: string }; methods: MethodStat[] };
type State = { plugin: string; name: string; version: string; enabled: boolean; running: boolean; error?: { code: string; message: string } | null; fault?: string | null };
type Report = { at: number; plugins: State[]; summary: Sum[]; events: Ev[] };

const time = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
const health = (s?: Sum, st?: State) => {
  if (st?.fault || st?.error) return { tone: "bad", text: st.fault ? "已停用（运行时故障）" : "加载失败" };
  if (!s || !s.calls) return { tone: "idle", text: "暂无调用" };
  // 插件返回成功不等于能播：播放器报错（MEDIA_ERR）也计入，并单独标出
  const pf = s.playFailures || 0, plays = s.plays || 0;
  if (pf && plays && pf / plays >= 0.5) return { tone: "bad", text: `播放失败 ${pf}/${plays}` };
  const r = s.errors / s.calls;
  if (r >= 0.5) return { tone: "bad", text: `失败率 ${Math.round(r * 100)}%` };
  if (pf) return { tone: "warn", text: `播放失败 ${pf}${plays ? "/" + plays : ""} 次` };
  if (r > 0 || s.maxMs > 20000) return { tone: "warn", text: r > 0 ? `失败 ${s.errors}/${s.calls}` : "响应偏慢" };
  return { tone: "ok", text: "正常" };
};
const toneColor: Record<string, string> = { ok: "#3ecf8e", warn: "#f5a623", bad: "#ff5f56", idle: "#7a7a85" };

/** 诊断中心：汇总所有源的调用情况，出问题时一眼看到哪个源、哪个方法、什么错误，并可一键复制报告。 */
export default function DiagnosticsPage({ onBack }: { onBack: () => void }) {
  const request = usePluginRequests();
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<string | null>(null), [onlyErrors, setOnlyErrors] = useState(false), [copied, setCopied] = useState("");
  const load = async () => {
    setBusy(true); setError("");
    try { setReport(await request<Report>("diagnostics", { limit: 800 })); } catch (e) { setError(pluginError(e)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, []);

  const rows = useMemo(() => {
    if (!report) return [];
    const sums = new Map(report.summary.map(s => [s.plugin, s]));
    return report.plugins.filter(p => p.enabled || sums.has(p.plugin)).map(st => ({ st, s: sums.get(st.plugin) }))
      .sort((a, b) => {
        const rank = (x: typeof a) => ({ bad: 0, warn: 1, ok: 2, idle: 3 } as Record<string, number>)[health(x.s, x.st).tone];
        return rank(a) - rank(b) || (b.s?.lastAt || 0) - (a.s?.lastAt || 0);
      });
  }, [report]);
  const nameOf = useMemo(() => new Map((report?.plugins || []).map(p => [p.plugin, p.name])), [report]);
  const events = useMemo(() => (report?.events || []).filter(e => (!focus || e.plugin === focus) && (!onlyErrors || e.ok === false || e.level === "error" || e.level === "warn")), [report, focus, onlyErrors]);

  const copy = async (all: boolean) => {
    if (!report) return;
    const pick = all ? rows : rows.filter(r => r.st.plugin === focus);
    const lines = [`HGhub 诊断报告 ${new Date(report.at).toLocaleString("zh-CN", { hour12: false })}`];
    for (const { st, s } of pick) {
      const h = health(s, st);
      lines.push(`\n## ${st.name} (${st.plugin} v${st.version}) — ${h.text}`);
      if (st.fault) lines.push(`运行时：${st.fault}`);
      if (st.error) lines.push(`加载：${st.error.code} ${st.error.message}`);
      if (s) {
        lines.push(`调用 ${s.calls} 次，失败 ${s.errors}，播放器失败 ${s.playFailures || 0}，平均 ${s.avgMs}ms，最长 ${s.maxMs}ms` + (Object.keys(s.codes).length ? `，错误码 ${Object.entries(s.codes).map(([c, n]) => `${c}×${n}`).join(" ")}` : ""));
        for (const m of s.methods) lines.push(`  ${m.method}: ${m.calls} 次 / 失败 ${m.errors} / 平均 ${m.avgMs}ms / 最长 ${m.maxMs}ms`);
      }
      const ev = report.events.filter(e => e.plugin === st.plugin && (e.ok === false || e.level)).slice(0, 15);
      for (const e of ev) lines.push(`  [${time(e.at)}] ${e.kind === "call" ? `${e.method} ${e.ms}ms ${e.code} ${e.message}${e.params ? " " + JSON.stringify(e.params) : ""}` : `${e.level} ${e.message}`}`);
    }
    const text = lines.join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(all ? "已复制全部报告" : "已复制该源报告"); }
    catch { setCopied("复制失败：剪贴板不可用"); }
    setTimeout(() => setCopied(""), 2500);
  };
  const clear = async () => { try { await request("diagnostics.clear"); await load(); } catch (e) { setError(pluginError(e)); } };

  const totals = rows.reduce((a, r) => { const t = health(r.s, r.st).tone; a[t] = (a[t] || 0) + 1; return a; }, {} as Record<string, number>);
  return <div className="absolute inset-0 bg-bg flex flex-col hpp-diagnostics">
    <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
      <div className="px-3 pt-2 pb-3 flex items-center gap-2">
        <button onClick={onBack} aria-label="返回" className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
        <h1 className="flex-1 text-[20px] font-bold text-on">诊断中心</h1>
        <button onClick={() => void load()} disabled={busy} aria-label="刷新" className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IRefresh size={18} /></button>
      </div>
      <div className="px-4 pb-3 flex flex-wrap gap-2 text-[11px]">
        {(["bad", "warn", "ok", "idle"] as const).map(t => <span key={t} className="px-2 py-1 rounded-full bg-s3 text-on"><i style={{ display: "inline-block", width: 7, height: 7, borderRadius: 9, background: toneColor[t], marginRight: 5 }} />{({ bad: "异常", warn: "有失败", ok: "正常", idle: "未调用" })[t]} {totals[t] || 0}</span>)}
        <button className="px-2 py-1 rounded-full bg-s3 text-primary" onClick={() => void copy(true)}>复制全部报告</button>
        <button className="px-2 py-1 rounded-full bg-s3 text-mut" onClick={() => void clear()}>清空</button>
      </div>
    </div>
    <div className="flex-1 overflow-y-auto px-3 pb-24">
      {error && <p className="text-[12px] text-red-400 p-2">{error}</p>}
      {copied && <p className="text-[12px] text-primary p-2" role="status">{copied}</p>}
      <p className="text-[10.5px] text-mut px-1 py-2">自动记录所有源的每次调用（首页、分类、搜索、详情、播放…），每 5 秒刷新。参数里不记录账号密码。出问题时点「复制报告」发给开发者。</p>
      {rows.map(({ st, s }) => {
        const h = health(s, st), open = focus === st.plugin;
        return <div key={st.plugin} className="rounded-(--r-sm) bg-s1 mb-2 overflow-hidden">
          <button className="w-full text-left px-3 py-2.5 flex items-center gap-2.5" onClick={() => setFocus(open ? null : st.plugin)}>
            <i style={{ width: 9, height: 9, borderRadius: 9, background: toneColor[h.tone], flexShrink: 0 }} />
            <span className="flex-1 min-w-0"><span className="block text-[13px] text-on truncate">{st.name} <small className="text-mut">v{st.version}</small></span>
              <span className="block text-[10.5px] text-mut truncate">{h.text}{s ? ` · ${s.calls} 次 · 平均 ${s.avgMs}ms` : ""}{s?.lastError ? ` · 最近错误 ${s.lastError.method}：${s.lastError.message}` : ""}</span></span>
          </button>
          {open && <div className="px-3 pb-3 text-[11px] text-on">
            {st.fault && <p className="text-red-400 mb-1">运行时：{st.fault}</p>}
            {st.error && <p className="text-red-400 mb-1">加载：{st.error.code} {st.error.message}</p>}
            {s && <table className="w-full mb-2" style={{ borderCollapse: "collapse" }}><thead><tr className="text-mut"><th className="text-left font-normal">方法</th><th className="font-normal">次数</th><th className="font-normal">失败</th><th className="font-normal">平均</th><th className="font-normal">最长</th></tr></thead>
              <tbody>{s.methods.map(m => <tr key={m.method}><td className="py-0.5">{m.method}</td><td className="text-center">{m.calls}</td><td className="text-center" style={{ color: m.errors ? toneColor.bad : undefined }}>{m.errors}</td><td className="text-center">{m.avgMs}ms</td><td className="text-center">{m.maxMs}ms</td></tr>)}</tbody></table>}
            {s && !!Object.keys(s.codes).length && <p className="text-mut mb-2">错误码：{Object.entries(s.codes).map(([c, n]) => `${c} × ${n}`).join("，")}</p>}
            <div className="flex gap-2"><button className="px-2 py-1 rounded-full bg-s3 text-primary" onClick={() => void copy(false)}>复制该源报告</button>
              <label className="px-2 py-1 rounded-full bg-s3 flex items-center gap-1"><input type="checkbox" checked={onlyErrors} onChange={e => setOnlyErrors(e.target.checked)} />只看错误</label></div>
          </div>}
        </div>;
      })}
      {!!report && !rows.length && <p className="text-[12px] text-mut p-3">还没有已启用的源。</p>}
      <h2 className="text-[12px] text-mut mt-4 mb-1 px-1">{focus ? `${rows.find(r => r.st.plugin === focus)?.st.name || focus} 的事件` : "全部最近事件"}（{events.length}）</h2>
      <ul className="text-[10.5px] leading-snug">
        {events.slice(0, 300).map((e, i) => <li key={i} className="px-2 py-1 border-b border-s3 flex gap-2">
          <span className="text-mut shrink-0">{time(e.at)}</span>
          <span className="shrink-0" style={{ color: e.kind === "call" ? (e.ok ? toneColor.ok : toneColor.bad) : e.level === "error" ? toneColor.bad : toneColor.warn }}>●</span>
          <span className="min-w-0 break-all">{!focus && <b className="text-on">{e.name || nameOf.get(e.plugin) || e.plugin} </b>}
            {e.kind === "call" ? <>{e.method} <span className="text-mut">{e.ms}ms</span>{e.ok ? "" : ` ${e.code}：${e.message}`}{e.warnings ? ` · 数据修正 ${e.warnings}` : ""}{e.params ? <span className="text-mut"> {JSON.stringify(e.params)}</span> : null}</> : <>{e.message}</>}</span>
        </li>)}
      </ul>
    </div>
  </div>;
}
