//! Writes parity/native/goldens.json: every case of parity/native/cases.json
//! run through pflow-native's registry natively.
//!
//! A case is one session: load the fixture (`file.load_json`, as the wasm
//! Engine's `load` does), then run each step with `Session::execute`. After
//! every step the artifacts it made are exported (`export.artifact`, json) and
//! after the last the document (`file.export_json`, rates included). An error
//! is a result too: its message is the golden.
//!
//! usage: native-goldens [--cases parity/native/cases.json] [--out parity/native/goldens.json]
//! (paths are relative to the repository root; run it from there)

use pflow_native_core::session::Session;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs;

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

fn main() {
    let cases_path = arg("cases", "parity/native/cases.json");
    let out_path = arg("out", "parity/native/goldens.json");
    let cases: Value = serde_json::from_str(&fs::read_to_string(&cases_path).expect("read cases")).expect("cases json");
    let mut out = Vec::new();
    for case in cases["cases"].as_array().expect("cases[]") {
        let name = case["name"].as_str().expect("name");
        let fixture = case["fixture"].as_str().expect("fixture");
        let text = fs::read_to_string(format!("parity/{fixture}")).unwrap_or_else(|e| panic!("{name}: fixture {fixture}: {e}"));
        let mut sess = Session::default();
        sess.execute("file.load_json", json!({ "json": text }))
            .unwrap_or_else(|e| panic!("{name}: loading {fixture}: {e}"));
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
        "pflow_native": "1a44427b8ca0a6af56f6f629e810fb9c38f09a5b",
        "cases": out,
    });
    fs::write(&out_path, serde_json::to_string_pretty(&doc).unwrap() + "\n").expect("write goldens");
    println!("wrote {out_path}: {} cases", doc["cases"].as_array().unwrap().len());
}
