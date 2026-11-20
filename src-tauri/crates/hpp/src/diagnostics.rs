//! 全局诊断中心：自动记录所有插件的每次调用（方法、耗时、结果），并汇总统计。
//! 插件无需任何改动；用于「出问题时一眼看出是哪个源、哪个方法、什么错误」。
use crate::store::now;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Mutex,
};

const MAX_EVENTS: usize = 3000;

#[derive(Default, Clone)]
struct Stat {
    calls: u64,
    errors: u64,
    total_ms: u64,
    max_ms: u64,
    last_at: u64,
    last_error: Option<Value>,
    codes: BTreeMap<String, u64>,
}

#[derive(Default)]
pub struct Diagnostics {
    events: Mutex<VecDeque<Value>>,
    stats: Mutex<BTreeMap<(String, String), Stat>>,
}

/// 参数摘要：只保留调试有用、不含敏感值的字段，长度受限。
fn brief(method: &str, params: &Value) -> Value {
    if method.starts_with("auth.") || method == "ui.submit" {
        return Value::Null; // 可能含账号密码
    }
    let mut out = serde_json::Map::new();
    if let Some(o) = params.as_object() {
        for k in [
            "id", "mediaId", "episodeId", "categoryId", "sectionId", "cursor", "query", "sort",
            "playlistId", "serverId", "reason", "articleId",
        ] {
            if let Some(v) = o.get(k) {
                let v = match v {
                    Value::String(s) => Value::String(s.chars().take(80).collect()),
                    Value::Number(_) | Value::Bool(_) => v.clone(),
                    _ => continue,
                };
                out.insert(k.into(), v);
            }
        }
    }
    if out.is_empty() { Value::Null } else { Value::Object(out) }
}

impl Diagnostics {
    pub fn record_call(
        &self,
        plugin: &str,
        name: &str,
        version: &str,
        method: &str,
        params: &Value,
        ms: u64,
        error: Option<(&str, &str)>,
        warnings: usize,
    ) {
        let at = now();
        let mut ev = json!({
            "at": at, "kind": "call", "plugin": plugin, "name": name, "version": version,
            "method": method, "ms": ms, "ok": error.is_none(),
        });
        let b = brief(method, params);
        if !b.is_null() { ev["params"] = b; }
        if warnings > 0 { ev["warnings"] = json!(warnings); }
        if let Some((code, message)) = error {
            ev["code"] = json!(code);
            ev["message"] = json!(message.chars().take(300).collect::<String>());
        }
        {
            let mut stats = self.stats.lock().unwrap();
            let s = stats.entry((plugin.to_string(), method.to_string())).or_default();
            s.calls += 1;
            s.total_ms += ms;
            s.max_ms = s.max_ms.max(ms);
            s.last_at = at;
            if let Some((code, message)) = error {
                s.errors += 1;
                *s.codes.entry(code.to_string()).or_default() += 1;
                s.last_error = Some(json!({"at": at, "code": code, "message": message.chars().take(300).collect::<String>()}));
            }
        }
        self.push(ev);
    }

    /// 运行时级事件（故障、停用、重建、加载失败）以及插件自己的 hg.log 的 warn/error。
    pub fn record_event(&self, plugin: &str, level: &str, text: &str) {
        self.push(json!({
            "at": now(), "kind": "event", "plugin": plugin, "level": level,
            "message": text.chars().take(500).collect::<String>(),
        }));
    }

    fn push(&self, ev: Value) {
        let mut e = self.events.lock().unwrap();
        e.push_back(ev);
        while e.len() > MAX_EVENTS { e.pop_front(); }
    }

    /// 最近事件，按条件过滤，新的在前。
    pub fn events(&self, plugin: Option<&str>, only_errors: bool, limit: usize) -> Vec<Value> {
        let e = self.events.lock().unwrap();
        e.iter()
            .rev()
            .filter(|v| plugin.map_or(true, |p| v["plugin"] == p))
            .filter(|v| !only_errors || v["ok"] == false || matches!(v["level"].as_str(), Some("error" | "warn")))
            .take(limit.clamp(1, MAX_EVENTS))
            .cloned()
            .collect()
    }

    /// 按插件汇总：调用数、失败数、平均/最长耗时、各错误码次数、最近一次错误、各方法明细。
    pub fn summary(&self) -> Vec<Value> {
        let stats = self.stats.lock().unwrap();
        let mut by: BTreeMap<String, Vec<(String, Stat)>> = BTreeMap::new();
        for ((p, m), s) in stats.iter() {
            by.entry(p.clone()).or_default().push((m.clone(), s.clone()));
        }
        let events = self.events.lock().unwrap();
        let mut out = Vec::new();
        for (plugin, methods) in by {
            let calls: u64 = methods.iter().map(|(_, s)| s.calls).sum();
            let errors: u64 = methods.iter().map(|(_, s)| s.errors).sum();
            let total: u64 = methods.iter().map(|(_, s)| s.total_ms).sum();
            let max_ms = methods.iter().map(|(_, s)| s.max_ms).max().unwrap_or(0);
            let last_at = methods.iter().map(|(_, s)| s.last_at).max().unwrap_or(0);
            let mut codes: BTreeMap<String, u64> = BTreeMap::new();
            for (_, s) in &methods { for (c, n) in &s.codes { *codes.entry(c.clone()).or_default() += n; } }
            let last_error = methods.iter()
                .filter_map(|(m, s)| s.last_error.clone().map(|mut e| { e["method"] = json!(m); e }))
                .max_by_key(|e| e["at"].as_u64().unwrap_or(0));
            let faults = events.iter().filter(|e| e["plugin"] == plugin.as_str() && e["kind"] == "event" && e["level"] == "error").count();
            let name = events.iter().rev().find(|e| e["plugin"] == plugin.as_str() && e["name"].is_string())
                .map(|e| e["name"].clone()).unwrap_or(json!(plugin));
            let version = events.iter().rev().find(|e| e["plugin"] == plugin.as_str() && e["version"].is_string())
                .map(|e| e["version"].clone()).unwrap_or(Value::Null);
            out.push(json!({
                "plugin": plugin, "name": name, "version": version,
                "calls": calls, "errors": errors, "faults": faults,
                "avgMs": if calls > 0 { total / calls } else { 0 }, "maxMs": max_ms, "lastAt": last_at,
                "codes": codes, "lastError": last_error,
                "methods": methods.iter().map(|(m, s)| json!({
                    "method": m, "calls": s.calls, "errors": s.errors,
                    "avgMs": if s.calls > 0 { s.total_ms / s.calls } else { 0 }, "maxMs": s.max_ms,
                })).collect::<Vec<_>>(),
            }));
        }
        out.sort_by(|a, b| {
            let k = |v: &Value| (v["errors"].as_u64().unwrap_or(0) + v["faults"].as_u64().unwrap_or(0), v["lastAt"].as_u64().unwrap_or(0));
            k(b).cmp(&k(a))
        });
        out
    }

    pub fn clear(&self) {
        self.events.lock().unwrap().clear();
        self.stats.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_and_summarizes() {
        let d = Diagnostics::default();
        d.record_call("a", "A", "1.0", "catalog.list", &json!({"categoryId":"x","password":"p"}), 120, None, 0);
        d.record_call("a", "A", "1.0", "catalog.list", &json!({}), 300, Some(("TIMEOUT", "超时")), 0);
        d.record_call("b", "B", "2.0", "auth.submit", &json!({"values":{"pw":"secret"}}), 10, None, 0);
        d.record_event("a", "error", "运行时连续故障");
        let s = d.summary();
        assert_eq!(s[0]["plugin"], "a");
        assert_eq!(s[0]["errors"], 1);
        assert_eq!(s[0]["faults"], 1);
        assert_eq!(s[0]["codes"]["TIMEOUT"], 1);
        assert_eq!(s[0]["maxMs"], 300);
        let ev = d.events(None, false, 10);
        assert!(ev.iter().all(|e| !e.to_string().contains("secret") && !e.to_string().contains("password")));
        assert_eq!(d.events(Some("a"), true, 10).len(), 2);
    }
}
