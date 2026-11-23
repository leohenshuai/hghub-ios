import { pluginCommand, pluginError, type InstalledPlugin } from "./client";

/** 一个源的体检结果 */
export type CheckResult = {
  id: string; name: string; version: string;
  state: "ok" | "warn" | "bad" | "skip";
  summary: string;
  steps: { name: string; ok: boolean; detail: string }[];
  ms: number;
};
export type Progress = { done: number; total: number; current: string };

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const short = (e: unknown) => pluginError(e).slice(0, 80);

function call<T>(id: string, method: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const requestId = uid();
  const p = pluginCommand<T>("call", { id, method, args, requestId }, { notifyAuth: false });
  if (signal) signal.addEventListener("abort", () => void pluginCommand("cancel", { requestId }).catch(() => {}), { once: true });
  return p;
}
const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("超时")), ms))]);

type Item = { id: string; title?: string };
type Page = { items?: Item[] };
type Cat = { id: string; label?: string; title?: string; children?: Cat[] };
type Detail = { id?: string; title?: string; playlists?: { id: string; episodes?: { id: string }[] }[] };
type Playback = { streams?: { url: string; format?: string; kind?: string; headers?: Record<string, string>; transforms?: Record<string, { type?: string; name?: string } | null> }[] };

/**
 * 在 App 里体检一个源：分类 → 列表 → 详情 → 解析播放 → 真实请求视频流首个分片。
 * 用的是 App 自己的网络与插件运行时，所以结论与实际观看一致（这正是云端体检做不到的）。
 */
export async function checkPlugin(p: InstalledPlugin, signal?: AbortSignal): Promise<CheckResult> {
  const t0 = Date.now();
  const id = p.meta.id;
  const r: CheckResult = { id, name: p.meta.name, version: p.meta.version, state: "ok", summary: "", steps: [], ms: 0 };
  const add = (name: string, ok: boolean, detail = "") => r.steps.push({ name, ok, detail });
  if (!p.enabled) { r.state = "skip"; r.summary = "未启用"; return r; }

  let sample: Item | undefined;
  const take = (page?: Page) => { if (!sample) sample = (page?.items || [])[0]; return (page?.items || []).length; };

  try {
    if (p.methods.includes("home.getSections")) {
      try {
        const h = await withTimeout(call<{ items?: { items?: Item[] }[] }>(id, "home.getSections", {}, signal), 25000);
        const n = (h.items || []).reduce((s, x) => s + (x.items || []).length, 0);
        for (const s of h.items || []) if (!sample) sample = (s.items || [])[0];
        add("首页", n > 0, n ? `${n} 条` : "空");
      } catch (e) { add("首页", false, short(e)); }
    }
    if (p.methods.includes("catalog.list")) {
      try {
        const cats = await withTimeout(call<Cat[]>(id, "catalog.getCategories", {}, signal), 20000);
        const leaves = (cats || []).flatMap(c => (c.children?.length ? c.children : [c]));
        add("分类", leaves.length > 0, `${leaves.length} 个`);
        if (leaves.length) {
          const first = leaves[0];
          const page = await withTimeout(call<Page>(id, "catalog.list", { categoryId: first.id, limit: 20 }, signal), 25000);
          const n = take(page);
          add("列表", n > 0, n ? `${n} 条` : `「${first.label || first.title || first.id}」为空`);
        }
      } catch (e) { add("分类", false, short(e)); }
    }
    if (p.methods.includes("media.getDetail") && sample) {
      try {
        const d = await withTimeout(call<Detail>(id, "media.getDetail", { id: sample.id }, signal), 25000);
        const pl = (d.playlists || []).find(x => x.episodes?.length);
        add("详情", !!pl, pl ? `${(d.title || "").slice(0, 14)} · ${pl.episodes!.length} 集` : "无可播分集");
        if (pl) {
          const pb = await withTimeout(call<Playback>(id, "media.resolvePlayback",
            { mediaId: d.id || sample.id, episodeId: pl.episodes![0].id, playlistId: pl.id, reason: "play", codecs: ["h264", "hevc"] }, signal), 35000);
          const s = (pb.streams || [])[0];
          if (!s) add("播放地址", false, "没有播放流");
          else if (s.kind === "external" || s.kind === "page") add("播放地址", true, "网盘/外部链接（需手动打开）");
          else {
            add("播放地址", true, s.format || "");
            // 真实拉一次：解析成功不代表能播，这一步才对应实际观看。
            // 但带 plugin 资源变换的流（如 Rou 把清单/分片包在 PNG 里）原始内容必然不是清单，
            // 变换只在媒体代理里发生，探针绕过代理直拉时不能按原始内容判失败，只看可达性。
            const hasTransform = !!(s.transforms && Object.values(s.transforms).some(t => t && t.type === "plugin"));
            const probe = await probeStream(id, s.url, s.headers, s.format, hasTransform);
            add("视频流", probe.ok, probe.detail);
          }
        }
      } catch (e) { add("详情/播放", false, short(e)); }
    }
  } catch (e) { add("体检", false, short(e)); }

  r.ms = Date.now() - t0;
  const failed = r.steps.filter(s => !s.ok);
  const fatal = failed.some(s => ["视频流", "播放地址", "详情/播放"].includes(s.name)) || r.steps.length === 0;
  r.state = !failed.length ? "ok" : fatal ? "bad" : "warn";
  r.summary = !failed.length ? "正常" : failed.map(s => `${s.name}：${s.detail}`).join("；").slice(0, 120);
  return r;
}

/** 走宿主的媒体代理之外，直接按插件给的请求头拉一次：HLS 读清单，普通视频读开头几十 KB。
 *  hasTransform 的流原始内容是变换前的包装格式（如 PNG 包着的清单），不按内容判失败。 */
async function probeStream(id: string, url: string, headers: Record<string, string> | undefined, format: string | undefined, hasTransform = false) {
  try {
    const res = await pluginCommand<{ status: number; contentType?: string; bodyHead?: string; ok: boolean }>(
      "diagnostics.probe", { id, url, headers: headers || {}, hls: format === "hls" });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status || 0}${res.contentType ? " " + res.contentType : ""}` };
    if (format === "hls" && !hasTransform && res.bodyHead && !res.bodyHead.startsWith("#EXTM3U")) return { ok: false, detail: `返回的不是清单（${res.contentType || "?"}）` };
    return { ok: true, detail: `${res.status} ${res.contentType || ""}${hasTransform ? "（经插件变换解包）" : ""}`.trim() };
  } catch (e) {
    return { ok: false, detail: short(e) };
  }
}

/** 依次体检多个源（串行，避免同时打多个站点被风控） */
export async function checkAll(plugins: InstalledPlugin[], onProgress: (p: Progress) => void, signal?: AbortSignal) {
  const list = plugins.filter(p => p.enabled && p.meta.kind !== "resolver");
  const out: CheckResult[] = [];
  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) break;
    onProgress({ done: i, total: list.length, current: list[i].meta.name });
    out.push(await checkPlugin(list[i], signal));
  }
  onProgress({ done: out.length, total: list.length, current: "" });
  return out;
}

// ---- 结果留存：启动时后台跑完，稍后在诊断中心查看 ----
const KEY = "hpp.sourceCheck";
export type Saved = { at: number; results: CheckResult[] };
export function readChecks(): Saved | null {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); return v && Array.isArray(v.results) ? v : null; } catch { return null; }
}
export function saveChecks(results: CheckResult[]) {
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), results })); } catch { /* 存不下就算了 */ }
}

/**
 * 启动时的后台体检：延后 20 秒再开始，避开启动高峰；同一天只跑一次，避免反复打扰站点。
 * 返回一个取消函数。
 */
export function scheduleStartupCheck(plugins: InstalledPlugin[], onDone?: (r: CheckResult[]) => void) {
  const last = readChecks();
  if (last && Date.now() - last.at < 20 * 3600 * 1000) return () => {};
  const ac = new AbortController();
  const timer = setTimeout(() => {
    void checkAll(plugins, () => {}, ac.signal).then(r => {
      if (ac.signal.aborted || !r.length) return;
      saveChecks(r); onDone?.(r);
    }).catch(() => {});
  }, 20000);
  return () => { clearTimeout(timer); ac.abort(); };
}
