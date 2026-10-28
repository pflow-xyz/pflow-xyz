//! Writes the native parity goldens, both from pflow-native's registry run
//! natively (not wasm):
//!
//! - parity/native/goldens.json: every case of parity/native/cases.json, for
//!   the wasm (native_parity_test.ts).
//! - parity/native/mcp_goldens.json: every case of parity/native/mcp_cases.json,
//!   for the /mcp workbench tools (cmd/webserver/mcp_workbench_parity_test.go)
//!   and composition tools (cmd/webserver/mcp_models_parity_test.go).
//!
//! Every session has its own memory store, as each wasm Engine has (made the
//! thread's store, so a store.* case never touches the user's data directory),
//! and loads its fixture unjournaled, as the wasm Engine's `load` does.
//!
//! A registry case is one session: load the fixture (`file.load_json`, as the
//! wasm Engine's `load` does), then run each step with `Session::execute`.
//! After every step the artifacts it made are exported (`export.artifact`,
//! json) and after the last the document (`file.export_json`, rates
//! included). An error is a result too: its message is the golden.
//!
//! An MCP case names a /mcp tool and its arguments. The tool's web semantics
//! are the native commands the editor runs for it (`mcp_steps`), in a fresh
//! session on the fixture; their results are assembled into the shape the
//! tool returns, each artifact inlined as its data, and that is the golden
//! (`expect`, or `error`). The composition tools (pflow_bundle_*) are in
//! bundle.rs: they take a composition, not a net.
//!
//! usage: native-goldens [--only registry|mcp]
//!                       [--cases parity/native/cases.json] [--out parity/native/goldens.json]
//!                       [--mcp-cases parity/native/mcp_cases.json] [--mcp-out parity/native/mcp_goldens.json]
//! (paths are relative to the repository root; run it from there)

mod bundle;

use pflow_native_core::session::Session;
use pflow_native_core::store::{self, Store};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::sync::Arc;

/// The pflow-native commit Cargo.toml pins; both test suites compare it with
/// pflow-native-wasm.lock.
const PFLOW_NATIVE: &str = "1a13459afc5f780f549df10f5ee4d91046b2c5e0";

fn arg(name: &str, dflt: &str) -> String {
    let flag = format!("--{name}");
    let a: Vec<String> = std::env::args().collect();
    a.iter()
        .position(|x| *x == flag)
        .and_then(|i| a.get(i + 1).cloned())
        .unwrap_or_else(|| dflt.to_string())
}

/// Replace `{"$result": [step, "path", ...]}` with that step's earlier result
/// (a receipt made by one step is the input of the next).
fn resolve(v: &Value, results: &[Value]) -> Value {
    match v {
        Value::Object(m) if m.len() == 1 && m.contains_key("$result") => {
            let path = m["$result"].as_array().expect("$result is [step, keys...]");
            let mut cur = &results[path[0].as_u64().expect("step index") as usize];
            for k in &path[1..] {
                cur = &cur[k.as_str().expect("key")];
            }
            cur.clone()
        }
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), resolve(x, results))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(|x| resolve(x, results)).collect()),
        _ => v.clone(),
    }
}

/// A session with `fixture` (a path under parity/) loaded.
fn session(name: &str, fixture: &str) -> Session {
    let text = fs::read_to_string(format!("parity/{fixture}")).unwrap_or_else(|e| panic!("{name}: fixture {fixture}: {e}"));
    store::set_thread_store(Some(Arc::new(Store::memory())));
    let mut sess = Session::default();
    sess.execute_unjournaled("file.load_json", json!({ "json": text }))
        .unwrap_or_else(|e| panic!("{name}: loading {fixture}: {e}"));
    sess
}

/// The artifacts made since the last call (ids not in `seen`), exported as json.
fn new_artifacts(sess: &mut Session, name: &str, seen: &mut BTreeSet<String>) -> Map<String, Value> {
    let mut arts = Map::new();
    if let Ok(list) = sess.execute("artifact.list", Value::Null) {
        let ids: Vec<String> = list
            .as_array()
            .or_else(|| list["artifacts"].as_array())
            .map(|a| a.iter().filter_map(|x| x["id"].as_str().map(String::from)).collect())
            .unwrap_or_default();
        for id in ids {
            if seen.insert(id.clone()) {
                let exp = sess
                    .execute("export.artifact", json!({ "id": id, "format": "json" }))
                    .unwrap_or_else(|e| panic!("{name}: exporting {id}: {e}"));
                let parsed = match &exp {
                    Value::String(s) => serde_json::from_str(s).expect("artifact json"),
                    other => other.clone(),
                };
                arts.insert(id, parsed);
            }
        }
    }
    arts
}

// ------------------------------------------------------------ registry cases

fn registry_goldens(cases_path: &str, out_path: &str) {
    let cases: Value = serde_json::from_str(&fs::read_to_string(cases_path).expect("read cases")).expect("cases json");
    let mut out = Vec::new();
    for case in cases["cases"].as_array().expect("cases[]") {
        let name = case["name"].as_str().expect("name");
        let fixture = case["fixture"].as_str().expect("fixture");
        let mut sess = session(name, fixture);
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut results: Vec<Value> = Vec::new();
        let mut steps = Vec::new();
        for step in case["steps"].as_array().expect("steps[]") {
            let command = step["command"].as_str().expect("command");
            let args = resolve(step.get("args").unwrap_or(&Value::Null), &results);
            let mut rec = Map::new();
            rec.insert("command".into(), json!(command));
            if !args.is_null() {
                rec.insert("args".into(), args.clone());
            }
            if step.get("generate_only").and_then(Value::as_bool) == Some(true) {
                rec.insert("generate_only".into(), json!(true));
            }
            match sess.execute(command, args) {
                Ok(v) => {
                    results.push(v.clone());
                    rec.insert("result".into(), v);
                }
                Err(e) => {
                    results.push(Value::Null);
                    rec.insert("error".into(), json!(e.to_string()));
                }
            }
            // the artifacts this step made
            let arts = new_artifacts(&mut sess, name, &mut seen);
            if !arts.is_empty() {
                rec.insert("artifacts".into(), Value::Object(arts));
            }
            if let Some(t) = step.get("tolerance") {
                rec.insert("tolerance".into(), t.clone());
            }
            if let Some(i) = step.get("ignore") {
                rec.insert("ignore".into(), i.clone());
            }
            steps.push(Value::Object(rec));
        }
        let doc = sess
            .execute("file.export_json", json!({ "rates": true }))
            .unwrap_or_else(|e| panic!("{name}: exporting the document: {e}"));
        out.push(json!({ "name": name, "fixture": fixture, "steps": steps, "doc": doc }));
    }
    let doc = json!({
        "_comment": "Generated by parity/native/gen (cargo run, see the Makefile target native-goldens) from parity/native/cases.json; do not edit by hand. Replayed through the vendored wasm by parity/native/native_parity_test.ts.",
        "pflow_native": PFLOW_NATIVE,
        "cases": out,
    });
    fs::write(out_path, serde_json::to_string_pretty(&doc).unwrap() + "\n").expect("write goldens");
    println!("wrote {out_path}: {} cases", doc["cases"].as_array().unwrap().len());
}

// ------------------------------------------------------------ MCP cases

/// The sum of a fixture place's `initial` (one entry per color), as the
/// editor's `p.initial.reduce((x, y) => x + y, 0)`.
fn initial_sum(fixture: &Value, place: &str) -> Option<f64> {
    let p = fixture["places"].get(place)?;
    Some(match &p["initial"] {
        Value::Array(a) => a.iter().filter_map(Value::as_f64).sum(),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    })
}

/// The native commands a /mcp tool call stands for: what the editor runs for
/// the same command (public/petri-commands.js). An `Err` is the editor's
/// refusal, made before any native command runs.
fn mcp_steps(tool: &str, a: &Value, fixture: &Value) -> Result<Vec<(String, Value)>, String> {
    let without = |keys: &[&str]| -> Value {
        let mut m = a.as_object().cloned().unwrap_or_default();
        for k in keys {
            m.remove(*k);
        }
        Value::Object(m)
    };
    match tool {
        // Native sim.sde (pflow-solver's port of go-pflow's SDE). The editor's
        // sim.sde is petri-sde.js, the same port in document order. `places`
        // only filters the series the tool returns.
        "pflow_sde" => Ok(vec![("sim.sde".into(), without(&["places"]))]),
        // The editor's opt.optimize is the native command, in wasm.
        "pflow_optimize" => Ok(vec![("opt.optimize".into(), a.clone())]),
        // sim.what_if: sim.compare of the net as is and with `delta` more
        // tokens in `place`, on one shared seed. The tool also takes `samples`
        // (given to both scenarios when set; `places` only filters series)
        // and returns each arm's finals table, which is what sim.scenario
        // stores for the same scenario on the same seed (the identical run).
        "pflow_what_if" => {
            let place = a["place"].as_str().unwrap_or("");
            let now = match initial_sum(fixture, place) {
                Some(n) => n,
                None if fixture["transitions"].get(place).is_some() => {
                    return Err(format!("\"{place}\" is a transition, not a place"))
                }
                None => return Err(format!("\"{place}\" is not a place or transition")),
            };
            let delta = a.get("delta").and_then(Value::as_i64).unwrap_or(1);
            if now + (delta as f64) < 0.0 {
                return Err(format!("{place} has {now}; cannot remove {}", -delta));
            }
            let mut base = Map::new();
            base.insert("hours".into(), a.get("t_end").cloned().unwrap_or(json!(10)));
            base.insert("realizations".into(), a.get("runs").cloned().unwrap_or(json!(16)));
            base.insert("seed".into(), a.get("seed").cloned().unwrap_or(json!(7)));
            if let Some(s) = a.get("samples") {
                base.insert("samples".into(), s.clone());
            }
            let label = format!("{}{delta} {place}", if delta >= 0 { "+" } else { "" });
            let arm = |name: &str, marking: Option<Value>| {
                let mut m = Map::new();
                m.insert("name".into(), json!(name));
                m.extend(base.clone());
                if let Some(mk) = marking {
                    m.insert("marking".into(), mk);
                }
                Value::Object(m)
            };
            let mut marking = Map::new();
            marking.insert(place.to_string(), json!(now + delta as f64));
            let as_is = arm("as is", None);
            let more = arm(&label, Some(Value::Object(marking)));
            let summary = |v: &Value| {
                let mut v = v.clone();
                v["summary"] = json!(true);
                json!({ "scenario": v })
            };
            Ok(vec![
                ("sim.compare".into(), json!({ "seed": base["seed"].clone(), "scenarios": [as_is.clone(), more.clone()] })),
                ("sim.scenario".into(), summary(&as_is)),
                ("sim.scenario".into(), summary(&more)),
            ])
        }
        other => panic!("unknown MCP tool {other}"),
    }
}

/// An artifact's data, by the id a result names.
fn data(arts: &Map<String, Value>, id: &Value) -> Value {
    match id.as_str() {
        Some(id) => arts.get(id).map(|a| a["data"].clone()).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

/// What the tool returns, from the native results: the first result with the
/// artifacts it names inlined as their data.
fn mcp_expect(tool: &str, a: &Value, fixture: &Value, results: &[(Value, Map<String, Value>)]) -> Value {
    let (r0, arts0) = &results[0];
    let mut out = r0.as_object().cloned().unwrap_or_default();
    match tool {
        "pflow_sde" => {
            let id = out.remove("artifact").unwrap_or(Value::Null);
            out.insert("timeseries".into(), data(arts0, &id));
        }
        "pflow_optimize" => {
            for k in ["scatter", "table"] {
                let id = out.remove(k).unwrap_or(Value::Null);
                out.insert(k.into(), data(arts0, &id));
            }
        }
        "pflow_what_if" => {
            out.remove("artifacts");
            for k in ["timeseries", "table"] {
                let id = out.remove(k).unwrap_or(Value::Null);
                out.insert(k.into(), data(arts0, &id));
            }
            let finals: Vec<Value> = results[1..].iter().map(|(r, arts)| data(arts, &r["table"])).collect();
            out.insert("finals".into(), json!(finals));
            let place = a["place"].as_str().unwrap_or("");
            let now = initial_sum(fixture, place).unwrap_or(0.0);
            let delta = a.get("delta").and_then(Value::as_i64).unwrap_or(1);
            out.insert("place".into(), json!(place));
            out.insert("from".into(), json!(now));
            out.insert("to".into(), json!(now + delta as f64));
        }
        _ => unreachable!(),
    }
    Value::Object(out)
}

fn mcp_goldens(cases_path: &str, out_path: &str) {
    let cases: Value = serde_json::from_str(&fs::read_to_string(cases_path).expect("read mcp cases")).expect("mcp cases json");
    let mut out = Vec::new();
    let mut compositions = Map::new(); // the named compositions the bundle cases use
    for case in cases["cases"].as_array().expect("cases[]") {
        let name = case["name"].as_str().expect("name");
        let tool = case["tool"].as_str().expect("tool");
        if tool.starts_with("pflow_bundle_") {
            let empty = json!({});
            let comps = cases.get("compositions").unwrap_or(&empty);
            out.push(Value::Object(bundle::golden(case, comps, &mut compositions)));
            continue;
        }
        let fixture = case["fixture"].as_str().expect("fixture");
        let args = case.get("args").cloned().unwrap_or(json!({}));
        let doc: Value = serde_json::from_str(&fs::read_to_string(format!("parity/{fixture}")).expect("fixture")).expect("fixture json");
        let mut rec = Map::new();
        rec.insert("name".into(), json!(name));
        rec.insert("fixture".into(), json!(fixture));
        rec.insert("tool".into(), json!(tool));
        rec.insert("args".into(), args.clone());
        match mcp_steps(tool, &args, &doc) {
            Err(e) => {
                rec.insert("native".into(), json!([]));
                rec.insert("error".into(), json!(e));
            }
            Ok(steps) => {
                let mut sess = session(name, fixture);
                let mut seen: BTreeSet<String> = BTreeSet::new();
                let mut results = vec![];
                let mut error = None;
                for (command, a) in &steps {
                    match sess.execute(command, a.clone()) {
                        Ok(v) => {
                            let arts = new_artifacts(&mut sess, name, &mut seen);
                            results.push((v, arts));
                        }
                        Err(e) => {
                            error = Some(e.to_string());
                            break;
                        }
                    }
                }
                rec.insert(
                    "native".into(),
                    json!(steps.iter().map(|(c, a)| json!({"command": c, "args": a})).collect::<Vec<_>>()),
                );
                match error {
                    Some(e) => {
                        rec.insert("error".into(), json!(e));
                    }
                    None => {
                        rec.insert("expect".into(), mcp_expect(tool, &args, &doc, &results));
                    }
                }
            }
        }
        for k in ["tolerance", "why"] {
            if let Some(v) = case.get(k) {
                rec.insert(k.into(), v.clone());
            }
        }
        out.push(Value::Object(rec));
    }
    let doc = json!({
        "_comment": "Generated by parity/native/gen (cargo run, see the Makefile target native-goldens) from parity/native/mcp_cases.json; do not edit by hand. Each case is a /mcp tool call: `native` lists the pflow-native commands (or, for a PetriNetBundle document, the composition functions) it stands for, `expect` (or `error`) is what they return, in the tool's shape. The workbench tools (pflow_sde, pflow_what_if, pflow_optimize) are replayed by cmd/webserver/mcp_workbench_parity_test.go; the composition tools (pflow_bundle_*) by mcp_models_parity_test.go, with `compositions` holding the bundle native builds for each named composition.",
        "pflow_native": PFLOW_NATIVE,
        "compositions": compositions,
        "cases": out,
    });
    fs::write(out_path, serde_json::to_string_pretty(&doc).unwrap() + "\n").expect("write mcp goldens");
    println!("wrote {out_path}: {} cases", doc["cases"].as_array().unwrap().len());
}

fn main() {
    let only = arg("only", "");
    if only.is_empty() || only == "registry" {
        registry_goldens(&arg("cases", "parity/native/cases.json"), &arg("out", "parity/native/goldens.json"));
    }
    if only.is_empty() || only == "mcp" {
        mcp_goldens(&arg("mcp-cases", "parity/native/mcp_cases.json"), &arg("mcp-out", "parity/native/mcp_goldens.json"));
    }
}
