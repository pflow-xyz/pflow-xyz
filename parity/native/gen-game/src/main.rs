//! Writes parity/native/game_goldens.json: pflow-native's game.value and
//! game.move on the positions and calls of parity/native/game_cases.json.
//!
//! A set names a fixture (a path under parity/), the rules (sides, reward,
//! auto) that game, some positions and some calls. Every position is reached
//! by playing moves in a pflow-native session on the fixture (the automatic
//! transitions fired as they become enabled, as the search settles them), and
//! every call is run at every position, each in the session as it stands. The
//! golden case carries the whole input (fixture, marking, tool, args), so the
//! Go test needs nothing of how it was made, and what native answered: its
//! result (the Report's `artifact` id left out, which a stateless tool does
//! not make), or its error message.
//!
//! A position is `{"fire": [ids...]}` (played as given) or
//! `{"random": {"seed": S, "plies": N, "count": C}}`: C walks of up to N
//! moves, seeded, each ending at a position. `{"initial": true}` is the
//! fixture's own marking.
//!
//! usage: game-goldens [--cases parity/native/game_cases.json]
//!                     [--out parity/native/game_goldens.json]
//! (paths are relative to the repository root; run it from there)

use pflow_native_core::session::Session;
use pflow_native_core::store::{self, Store};
use serde_json::{json, Map, Value};
use std::fs;
use std::sync::Arc;

const PFLOW_NATIVE: &str = "cdd3816106e64df93456c45900ef92550cbbb90c";
const PFLOW_RS: &str = "35be80745784e9ed0375103bfc035ffcfcfaeb2c";

fn arg(name: &str, dflt: &str) -> String {
    let flag = format!("--{name}");
    let a: Vec<String> = std::env::args().collect();
    a.iter()
        .position(|x| *x == flag)
        .and_then(|i| a.get(i + 1).cloned())
        .unwrap_or_else(|| dflt.to_string())
}

fn session(fixture: &str) -> Session {
    let text = fs::read_to_string(format!("parity/{fixture}")).unwrap_or_else(|e| panic!("fixture {fixture}: {e}"));
    store::set_thread_store(Some(Arc::new(Store::memory())));
    let mut sess = Session::default();
    sess.execute_unjournaled("file.load_json", json!({ "json": text }))
        .unwrap_or_else(|e| panic!("loading {fixture}: {e}"));
    sess
}

struct Lcg(u64);
impl Lcg {
    fn below(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) % n
    }
}

fn prefixes(rules: &Value) -> Vec<String> {
    rules["auto"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn enabled(sess: &mut Session) -> Vec<String> {
    sess.enabled_transitions().into_iter().map(|t| t.to_string()).collect()
}

/// Fires the automatic transitions that are enabled, lowest (document order)
/// first, until none is.
fn settle(sess: &mut Session, auto: &[String]) {
    loop {
        let t = enabled(sess).into_iter().find(|t| auto.iter().any(|p| t.starts_with(p.as_str())));
        match t {
            Some(t) => {
                sess.execute("sim.fire", json!({ "id": t })).expect("fire auto");
            }
            None => return,
        }
    }
}

/// The marking as {place: count} over the places holding tokens.
fn marking(sess: &Session) -> Value {
    let mut m = Map::new();
    for (p, v) in &sess.marking {
        let n: i64 = v.iter().sum();
        if n != 0 {
            m.insert(p.clone(), json!(n));
        }
    }
    Value::Object(m)
}

/// The sessions' positions a set names, each as the marking reached.
fn positions(fixture: &str, rules: &Value, spec: &Value) -> Vec<(String, Value)> {
    let auto = prefixes(rules);
    let mut out = vec![];
    if spec.get("initial").is_some() {
        let mut s = session(fixture);
        settle(&mut s, &auto);
        out.push(("initial".to_string(), marking(&s)));
    }
    if let Some(fire) = spec.get("fire").and_then(Value::as_array) {
        let mut s = session(fixture);
        settle(&mut s, &auto);
        let mut label = String::new();
        for t in fire {
            let t = t.as_str().expect("fire id");
            s.execute("sim.fire", json!({ "id": t })).unwrap_or_else(|e| panic!("{fixture}: fire {t}: {e}"));
            settle(&mut s, &auto);
            label.push_str(&t.replace("_play_", "").replace("_take", ""));
            label.push('.');
        }
        out.push((format!("fire-{}", label.trim_end_matches('.')), marking(&s)));
    }
    if let Some(r) = spec.get("random") {
        let (seed, plies, count) = (r["seed"].as_u64().unwrap(), r["plies"].as_u64().unwrap(), r["count"].as_u64().unwrap());
        let mut rng = Lcg(seed);
        for i in 0..count {
            let mut s = session(fixture);
            settle(&mut s, &auto);
            let n = 1 + rng.below(plies);
            let mut played = 0;
            for _ in 0..n {
                let moves = enabled(&mut s);
                if moves.is_empty() {
                    break;
                }
                let t = moves[rng.below(moves.len() as u64) as usize].clone();
                s.execute("sim.fire", json!({ "id": t })).expect("fire");
                settle(&mut s, &auto);
                played += 1;
            }
            out.push((format!("rand{seed}-{i}-p{played}"), marking(&s)));
        }
    }
    out
}

/// A session at `marking` on `fixture`.
fn at(fixture: &str, mk: &Value) -> Session {
    let mut s = session(fixture);
    for (_, v) in s.marking.iter_mut() {
        for c in v.iter_mut() {
            *c = 0;
        }
    }
    for (p, n) in mk.as_object().unwrap() {
        s.marking.get_mut(p).expect("place")[0] = n.as_i64().unwrap();
    }
    s
}


/// The longest-prefix sign of transition `t` under `sides` (0 for none).
fn sign_of(sides: &Value, t: &str) -> f64 {
    let mut best: Option<(usize, f64)> = None;
    for (k, w) in sides.as_object().unwrap() {
        if t.starts_with(k.as_str()) && best.map_or(true, |b| k.len() > b.0) {
            best = Some((k.len(), w.as_f64().unwrap()));
        }
    }
    best.map_or(0.0, |b| b.1)
}

/// The text of a label cache for `fixture` and `rules`, as the experimental
/// rnn commands write it: a header naming the net and the rules, then, for
/// each position, its marking (dense, places by id) and the value of each of
/// its moves (by id) from the mover's view, which are native's own game.value
/// of the position after the move.
fn book_text(fixture: &str, rules: &Value, spec: &Value) -> String {
    let auto = prefixes(rules);
    let proto = session(fixture);
    let mut places: Vec<String> = proto.doc.places.iter().map(|p| p.id.clone()).collect();
    places.sort();
    let mut trans: Vec<String> = proto.doc.transitions.iter().map(|t| t.id.clone()).collect();
    trans.sort();
    let auto_flags: Vec<bool> = trans.iter().map(|t| auto.iter().any(|p| t.starts_with(p.as_str()))).collect();
    let sign: Vec<f64> = trans.iter().map(|t| sign_of(&rules["sides"], t)).collect();
    let reward: Vec<Value> = rules["reward"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, w)| json!([places.iter().position(|p| p == k).unwrap(), w.as_f64().unwrap()]))
        .collect();
    let mut header = json!({
        "labels": 1, "places": places, "transitions": trans, "auto": auto_flags, "sign": sign,
        "reward": reward, "budget": 1000000,
    });
    let mutate = spec.get("mutate").and_then(Value::as_str).unwrap_or("");
    match mutate {
        "header" => header["places"] = json!(["other"]),
        "sign" => header["sign"][0] = json!(-5.0),
        _ => {}
    }
    let mut lines = vec![header.to_string()];
    let dense = |s: &Session| -> Vec<i64> { places.iter().map(|p| s.marking[p][0]).collect() };
    for pos in spec["positions"].as_array().unwrap() {
        for (_, mk) in positions(fixture, rules, pos) {
            let s = at(fixture, &mk);
            let mut moves: Vec<String> = enabled(&mut { s }).into_iter().filter(|t| !auto.iter().any(|p| t.starts_with(p.as_str()))).collect();
            moves.sort();
            let s = at(fixture, &mk);
            let mut row = dense(&s);
            if mutate == "marking" {
                row.pop();
            }
            if moves.is_empty() {
                lines.push(json!({"mk": row, "vals": []}).to_string());
                continue;
            }
            let mover = sign_of(&rules["sides"], &moves[0]);
            let mut vals = vec![];
            for m in &moves {
                let mut c = at(fixture, &mk);
                c.execute("sim.fire", json!({ "id": m })).expect("fire");
                settle(&mut c, &auto);
                let mut c2 = at(fixture, &marking(&c));
                let r = c2.execute("game.value", rules.clone()).expect("value");
                vals.push(mover * r["value"].as_f64().expect("a value"));
            }
            if mutate == "short" {
                vals.pop();
            }
            if mutate == "null" {
                lines.push(json!({"mk": row, "vals": null}).to_string());
            } else {
                lines.push(json!({"mk": row, "vals": vals}).to_string());
            }
        }
    }
    match mutate {
        "final" => lines.push(json!({"mk": vec![0; places.len()], "vals": []}).to_string()),
        "cut" => {
            let last = lines.pop().unwrap();
            lines.push(last[..last.len() / 2].to_string());
        }
        "middle" => lines.insert(2, "{not json".to_string()),
        _ => {}
    }
    lines.join("\n") + "\n"
}

/// `args` with each {"$book": spec} replaced by the label cache text it names.
fn resolve_books(fixture: &str, rules: &Value, v: &Value) -> Value {
    match v {
        Value::Object(m) if m.len() == 1 && m.contains_key("$book") => json!(book_text(fixture, rules, &m["$book"])),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), resolve_books(fixture, rules, x))).collect()),
        _ => v.clone(),
    }
}

fn main() {
    let cases_path = arg("cases", "parity/native/game_cases.json");
    let out_path = arg("out", "parity/native/game_goldens.json");
    let spec: Value = serde_json::from_str(&fs::read_to_string(&cases_path).expect("read cases")).expect("cases json");
    let mut out = vec![];
    for set in spec["sets"].as_array().expect("sets[]") {
        let sname = set["name"].as_str().unwrap();
        let fixture = set["fixture"].as_str().unwrap();
        let rules = &spec["rules"][set["rules"].as_str().unwrap()];
        let calls = set["calls"].as_array().expect("calls[]");
        let mut pos = vec![];
        for p in set["positions"].as_array().expect("positions[]") {
            pos.extend(positions(fixture, rules, p));
        }
        for (plabel, mk) in &pos {
            for call in calls {
                let tool = call["tool"].as_str().unwrap();
                let mut args = Map::new();
                if call.get("rules").and_then(Value::as_bool) != Some(false) {
                    for (k, v) in rules.as_object().unwrap() {
                        args.insert(k.clone(), v.clone());
                    }
                }
                if let Some(extra) = call.get("args").and_then(Value::as_object) {
                    for (k, v) in extra {
                        if v.is_null() {
                            args.remove(k);
                        } else {
                            args.insert(k.clone(), v.clone());
                        }
                    }
                }
                let args = resolve_books(fixture, rules, &Value::Object(args));
                let mut s = at(fixture, mk);
                let mut rec = Map::new();
                rec.insert("name".into(), json!(format!("{sname}/{plabel}/{}", call["name"].as_str().unwrap())));
                rec.insert("fixture".into(), json!(fixture));
                rec.insert("marking".into(), mk.clone());
                rec.insert("tool".into(), json!(tool));
                rec.insert("args".into(), args.clone());
                // A plan naming the "ode" estimate: native solves the ODE,
                // the Go tool refuses it (see game_test.go).
                let names_ode = args["plan"].to_string().contains("\"ode\"");
                match s.execute(tool, args) {
                    Ok(mut v) => {
                        if names_ode {
                            rec.insert("ported".into(), json!(false));
                        }
                        if let Some(o) = v.as_object_mut() {
                            o.remove("artifact");
                        }
                        rec.insert("expect".into(), v);
                    }
                    Err(e) => {
                        rec.insert("error".into(), json!(e.to_string()));
                    }
                }
                out.push(Value::Object(rec));
            }
        }
    }
    let n = out.len();
    let doc = json!({
        "_comment": "Generated by parity/native/gen-game from game_cases.json (make game-goldens); see its Cargo.toml. Native's answer to each call, run natively.",
        "pflow_native": PFLOW_NATIVE,
        "pflow_rs": PFLOW_RS,
        "cases": out,
    });
    // One case to a line: the file is big, and a diff reads by case.
    let head = serde_json::to_string(&json!({"_comment": doc["_comment"], "pflow_native": PFLOW_NATIVE, "pflow_rs": PFLOW_RS})).unwrap();
    let cases: Vec<String> = doc["cases"].as_array().unwrap().iter().map(|c| serde_json::to_string(c).unwrap()).collect();
    let text = format!("{},\n \"cases\": [\n{}\n]}}\n", &head[..head.len() - 1], cases.join(",\n"));
    fs::write(&out_path, text).expect("write goldens");
    println!("wrote {n} cases to {out_path}");
}
