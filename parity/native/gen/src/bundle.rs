//! The pflow_bundle_* cases of mcp_cases.json: the /mcp composition tools
//! (cmd/webserver/mcp_model*.go) against pflow-native's composition rules.
//!
//! A case names a tool, its arguments and where its composition comes from:
//!
//! - `composition` (the name of an entry of the cases file's `compositions`,
//!   each {instances?, links?}: what `bundle.open` takes): the
//!   catalog composition is opened in a fresh session exactly as the wasm
//!   engine opens it, and each tool is the registry command(s) the composition
//!   page runs for it (`bundle.validate`, `bundle.add_link`, `bundle.candidates`,
//!   `bundle.flatten`, `bundle.run`, `bundle.incidence`; `pflow_bundle_example`
//!   is `bundle.instances` + `bundle.scenarios` + `bundle.state`). The same
//!   commands are in cases.json, which holds the wasm to native.
//! - `bundle_file` (a PetriNetBundle document, path relative to parity/): the
//!   registry cannot load one at this pin (`bundle.open` builds catalog
//!   instances), so the tool is the composition module's functions those
//!   commands call, run on the document: `Bundle::validate`,
//!   `composition::{flatten_json, incidence_json, candidates, run}` and
//!   `Composition::add_link`. They are the same code the commands run, so the
//!   answer is the one the registry would give for that document.
//!
//! The golden is the tool's answer in the tool's shape (`expect`, or `error`):
//! the native result without its artifact handle and without the `passed`
//! lists (each legal link's descriptive cites into go-pflow, which belong to
//! the page, not to a bundle). For a composition case the record also holds the
//! `bundle` native built (serialised by pflow-compose, the wire format go-pflow
//! reads), so the Go tools are run on native's own subnets. The goldens hold
//! each named composition once (`compositions`: its arguments and its bundle);
//! for `pflow_bundle_example` the record holds native's `subnets` and `links` in
//! the views' shape, against which the Go-built catalog is compared.

use pflow_compose::{Bundle, Endpoint, Link};
use pflow_native_core::composition::{self as comp, Composition};
use pflow_native_core::session::Session;
use pflow_native_core::store::{self, Store};
use serde_json::{json, Map, Value};
use std::fs;
use std::sync::Arc;

/// A session with the catalog composition `c` ({instances?, links?}) open, or
/// bundle.open's refusal.
fn open_session(c: &Value) -> Result<Session, String> {
    store::set_thread_store(Some(Arc::new(Store::memory())));
    let mut sess = Session::default();
    let mut a = Map::new();
    for k in ["instances", "links"] {
        if let Some(v) = c.get(k) {
            a.insert(k.into(), v.clone());
        }
    }
    sess.execute("bundle.open", Value::Object(a))
        .map_err(|e| e.to_string())?;
    Ok(sess)
}

/// The registry commands a tool stands for.
fn steps(tool: &str, a: &Value) -> Vec<(&'static str, Value)> {
    match tool {
        "pflow_bundle_validate" => vec![("bundle.validate", json!({}))],
        "pflow_bundle_flatten" => vec![("bundle.flatten", json!({}))],
        "pflow_bundle_incidence" => vec![("bundle.incidence", json!({}))],
        "pflow_bundle_add_link" => vec![("bundle.add_link", a.clone())],
        "pflow_bundle_candidates" => vec![("bundle.candidates", a.clone())],
        "pflow_bundle_run" => vec![("bundle.run", a.clone())],
        "pflow_bundle_example" => vec![
            ("bundle.instances", json!({})),
            ("bundle.scenarios", json!({})),
            ("bundle.state", json!({})),
        ],
        other => panic!("unknown bundle tool {other}"),
    }
}

/// Drops what the tools do not return: the artifact handle (a session id)
/// and every `passed` list.
fn project(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("artifact");
            m.remove("passed");
            for x in m.values_mut() {
                project(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(project),
        _ => {}
    }
}

fn projected(v: &Value) -> Value {
    let mut v = v.clone();
    project(&mut v);
    v
}

/// native's `subnet_json` reduced to what a bundle document says: no label,
/// pattern, parameters or why (the catalog's facts, returned as `catalog`),
/// no ontology key on a port.
fn subnet_view(s: &Value) -> Value {
    let ports: Vec<Value> = s["ports"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|p| {
                    json!({
                        "id": p["id"], "kind": p["kind"], "target": p["target"],
                        "place": p["place"], "transition": p["transition"], "schema": p["schema"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "id": s["id"], "net_type": s["net_type"], "model_name": s["model_name"],
        "ports": ports, "places": s["places"], "transitions": s["transitions"],
        "arcs": s["arcs"], "constraints": s["constraints"],
    })
}

/// The tool's answer from the registry results of a catalog composition.
fn registry_expect(tool: &str, sess: &Session, results: &[Value]) -> (Value, Option<Value>) {
    let bundle = &sess.composition.as_ref().expect("composition open").bundle;
    match tool {
        "pflow_bundle_add_link" => {
            let r = &results[0];
            (
                projected(&json!({
                    "index": r["index"], "link": r["link"], "key": r["key"], "verdict": r["verdict"],
                    "links": serde_json::to_value(&bundle.links).expect("links"),
                })),
                None,
            )
        }
        "pflow_bundle_example" => {
            let (inst, scen, state) = (&results[0], &results[1], &results[2]);
            let subnets: Vec<Value> = state["subnets"]
                .as_array()
                .expect("subnets")
                .iter()
                .map(subnet_view)
                .collect();
            (
                json!({
                    "catalog": inst["instances"], "default": inst["default"],
                    "default_links": inst["default_links"], "params_note": inst["params_note"],
                    "scenarios": scen["scenarios"], "instances": state["instances"],
                    "unavailable": state["unavailable"], "dropped_links": state["dropped_links"],
                }),
                Some(json!({
                    "subnets": subnets,
                    "links": serde_json::to_value(&bundle.links).expect("links"),
                })),
            )
        }
        _ => (projected(&results[0]), None),
    }
}

// ------------------------------------------------------------ a document, directly

fn issues(v: &[pflow_compose::ValidationError]) -> Vec<Value> {
    v.iter()
        .map(|e| json!({"code": e.code, "message": e.message, "element": e.element}))
        .collect()
}

fn link_arg(a: &Value) -> Result<Link, String> {
    let kind = comp::parse_kind(a["kind"].as_str().unwrap_or(""))?;
    let from = comp::parse_endpoint(&a["from"])?;
    let to = comp::parse_endpoint(&a["to"])?;
    Ok(comp::link(kind, from, to))
}

/// What bundle.run does (commands/bundle.rs run_cmd), on a document.
fn run_on(b: &Bundle, a: &Value) -> Result<Value, String> {
    let flat = comp::flatten(b)?;
    let script: Option<Vec<String>> = a.get("script").and_then(Value::as_array).map(|l| {
        l.iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect()
    });
    let r = match (a.get("scenario").and_then(Value::as_str), script) {
        (Some(id), None) => {
            let sc = comp::scenario(id).ok_or_else(|| {
                let ids: Vec<&str> = comp::scenarios().iter().map(|s| s.id).collect();
                format!("no scenario {id:?}; there are {ids:?}")
            })?;
            comp::run_scenario(&flat, sc)
        }
        (None, Some(script)) => comp::run(&flat, "script", "script", &script, &[]),
        _ => return Err("pass `scenario` or `script`".into()),
    };
    Ok(json!(r))
}

/// bundle.candidates (commands/bundle.rs candidates), on a document.
fn candidates_on(b: &Bundle, a: &Value) -> Result<Value, String> {
    let c = Composition {
        doc: Default::default(),
        specs: vec![],
        bundle: b.clone(),
        unavailable: vec![],
        dropped_links: vec![],
        game: Default::default(),
    };
    let from: Endpoint = comp::parse_endpoint(&a["from"])?;
    let prefer = a.get("prefer").and_then(Value::as_str).unwrap_or("auto");
    let list = comp::candidates(&c, &from, prefer)?;
    let lit = list.iter().filter(|c| c["ok"] == json!(true)).count();
    Ok(json!({
        "from": {"subnet": from.subnet, "port": from.port},
        "prefer": prefer,
        "lit": lit,
        "candidates": list,
    }))
}

/// bundle.add_link (commands/bundle.rs add_link), on a document.
fn add_link_on(b: &Bundle, a: &Value) -> Result<Value, String> {
    let l = link_arg(a)?;
    let mut c = Composition {
        doc: Default::default(),
        specs: vec![],
        bundle: b.clone(),
        unavailable: vec![],
        dropped_links: vec![],
        game: Default::default(),
    };
    let v = c.add_link(l.clone()).map_err(|v| v.refusal())?;
    Ok(json!({
        "index": c.bundle.links.len() - 1,
        "link": comp::link_json(&l),
        "key": comp::link_key(&l),
        "verdict": v,
        "links": serde_json::to_value(&c.bundle.links).expect("links"),
    }))
}

/// The tool on a document: the composition module's functions.
fn direct(tool: &str, a: &Value, b: &Bundle) -> (Vec<Value>, Result<Value, String>) {
    let (calls, answer): (&[&str], Result<Value, String>) = match tool {
        "pflow_bundle_validate" => {
            let res = b.validate();
            (
                &["Bundle::validate"],
                Ok(
                    json!({"valid": res.valid, "errors": issues(&res.errors), "warnings": issues(&res.warnings)}),
                ),
            )
        }
        "pflow_bundle_flatten" => (&["composition::flatten_json"], Ok(comp::flatten_json(b))),
        "pflow_bundle_incidence" => (
            &["composition::incidence_json"],
            Ok(comp::incidence_json(b)),
        ),
        "pflow_bundle_run" => (&["composition::flatten", "composition::run"], run_on(b, a)),
        "pflow_bundle_candidates" => (&["composition::candidates"], candidates_on(b, a)),
        "pflow_bundle_add_link" => (&["Composition::add_link"], add_link_on(b, a)),
        other => panic!("{other} has no document form"),
    };
    (
        calls.iter().map(|c| json!({"call": c})).collect(),
        answer.map(|v| projected(&v)),
    )
}

// ------------------------------------------------------------ the case

/// The golden record of one pflow_bundle_* case. `comps` are the cases file's
/// named compositions; the ones used are recorded, with the bundle native builds
/// for each, in `used`.
pub fn golden(case: &Value, comps: &Value, used: &mut Map<String, Value>) -> Map<String, Value> {
    let name = case["name"].as_str().expect("name");
    let tool = case["tool"].as_str().expect("tool");
    let args = case.get("args").cloned().unwrap_or(json!({}));
    let mut rec = Map::new();
    rec.insert("name".into(), json!(name));
    rec.insert("tool".into(), json!(tool));
    rec.insert("args".into(), args.clone());
    for k in ["composition", "bundle_file"] {
        if let Some(v) = case.get(k) {
            rec.insert(k.into(), v.clone());
        }
    }
    // the composition a case names, or none
    let named = case.get("composition").map(|n| {
        let n = n.as_str().expect("composition is a name");
        (
            n,
            comps
                .get(n)
                .unwrap_or_else(|| panic!("{name}: no composition {n:?}"))
                .clone(),
        )
    });
    let answer = if let Some(file) = case.get("bundle_file").and_then(Value::as_str) {
        let text = fs::read_to_string(format!("parity/{file}"))
            .unwrap_or_else(|e| panic!("{name}: {file}: {e}"));
        let b: Bundle = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{name}: {file} is not a bundle: {e}"));
        let (native, answer) = direct(tool, &args, &b);
        rec.insert("native".into(), json!(native));
        answer
    } else {
        // `pflow_bundle_example` takes the composition as its own arguments.
        let comp_args = match (&named, tool) {
            (_, "pflow_bundle_example") => args.clone(),
            (Some((_, c)), _) => c.clone(),
            (None, _) => panic!("{name}: a composition or a bundle_file"),
        };
        let steps = steps(tool, &args);
        rec.insert(
            "native".into(),
            json!(
                std::iter::once(json!({"command": "bundle.open", "args": comp_args}))
                    .chain(steps.iter().map(|(c, a)| json!({"command": c, "args": a})))
                    .collect::<Vec<_>>()
            ),
        );
        match open_session(&comp_args) {
            // the example tool is bundle.open: its refusal is the tool's
            Err(e) if tool == "pflow_bundle_example" => Err(e),
            Err(e) => panic!("{name}: bundle.open: {e}"),
            Ok(mut sess) => {
                if let Some((n, c)) = &named {
                    // as opened, before the steps edit it
                    let bundle = serde_json::to_value(
                        &sess.composition.as_ref().expect("composition open").bundle,
                    )
                    .expect("bundle");
                    used.entry(n.to_string())
                        .or_insert_with(|| json!({"args": c, "bundle": bundle}));
                }
                let mut results = vec![];
                let mut failed = None;
                for (command, a) in &steps {
                    match sess.execute(command, a.clone()) {
                        Ok(v) => results.push(v),
                        Err(e) => {
                            failed = Some(e.to_string());
                            break;
                        }
                    }
                }
                match failed {
                    Some(e) => Err(e),
                    None => {
                        let (expect, extra) = registry_expect(tool, &sess, &results);
                        if let Some(Value::Object(m)) = extra {
                            rec.extend(m);
                        }
                        Ok(expect)
                    }
                }
            }
        }
    };
    match answer {
        Ok(v) => rec.insert("expect".into(), v),
        Err(e) => rec.insert("error".into(), json!(e)),
    };
    for k in ["tolerance", "why"] {
        if let Some(v) = case.get(k) {
            rec.insert(k.into(), v.clone());
        }
    }
    rec
}
