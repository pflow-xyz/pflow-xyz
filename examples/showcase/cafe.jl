# Variation VIII — the theme in Julia. Loads cafe.jsonld (four token colors,
# per-color capacities, inhibitor and read arcs), recomputes its CID with
# pflow-jl's URDNA2015 port so it can be compared byte-for-byte with the Go
# and JS sealers, and inspects the structure through the AlgebraicPetri bridge.
#
#   julia --project=/home/myork/Workspace/pflow-jl cafe.jl
using pflow
using JSON

here = @__DIR__
doc  = read(joinpath(here, "cafe.jsonld"), String)
net  = from_json(doc)
println("places=", length(net.places), " transitions=", length(net.transitions), " arcs=", length(net.arcs), " colors=", length(net.token))
println("pantry initial=", net.places["pantry"].initial, " capacity=", net.places["pantry"].capacity)
inh = count(a -> a.inhibit_transition, net.arcs)
println("inhibitor/read arcs=", inh)
cid, _nquads = compute_cid(JSON.parse(doc))   # returns (cid, canonical N-Quads)
println("cid=", cid)
expected = JSON.parse(doc)["@id"]
println(cid == expected ? "CID matches @id (Go = JS = Julia)" : "CID MISMATCH: expected $expected")
