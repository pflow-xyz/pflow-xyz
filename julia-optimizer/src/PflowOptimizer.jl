"""
PflowOptimizer - Julia webservice for Petri net optimization and evaluation

This module provides HTTP endpoints for:
1. Optimizing Petri net transition rates (finding best rates to maximize/minimize a target)
2. Evaluating scenarios (running ODE simulation for given rates and returning results)
3. Comparing alternatives (expert system approach - evaluate multiple rate configurations)

Supports both continuous optimization and discrete decision-making (expert systems).
"""
module PflowOptimizer

using HTTP
using JSON
using DifferentialEquations
using LabelledArrays
using LinearAlgebra

export start_server

# Data structures
struct Place
    label::String
    initial::Vector{Int}
    capacity::Vector{Float64}
    x::Int
    y::Int
    label_text::Union{Nothing, String}
end

struct Transition
    label::String
    role::String
    x::Int
    y::Int
    label_text::Union{Nothing, String}
end

struct Arc
    source::String
    target::String
    weight::Vector{Int}
    inhibit_transition::Bool
end

struct PetriNet
    places::Dict{String, Place}
    transitions::Dict{String, Transition}
    arcs::Vector{Arc}
    token::Vector{String}
end

# Parse JSON-LD to PetriNet
function from_json(data::Dict)
    places = Dict{String, Place}()
    transitions = Dict{String, Transition}()
    arcs = Arc[]
    token = get(data, "token", String[])
    
    for (label, p) in get(data, "places", Dict())
        initial = get(p, "initial", Int[])
        capacity = get(p, "capacity", Float64[])
        x = get(p, "x", 0)
        y = get(p, "y", 0)
        label_text = get(p, "label_text", nothing)
        places[label] = Place(label, initial, capacity, x, y, label_text)
    end
    
    for (label, t) in get(data, "transitions", Dict())
        role = get(t, "role", "default")
        x = get(t, "x", 0)
        y = get(t, "y", 0)
        label_text = get(t, "label_text", nothing)
        transitions[label] = Transition(label, role, x, y, label_text)
    end
    
    for arc in get(data, "arcs", [])
        source = arc["source"]
        target = arc["target"]
        weight = get(arc, "weight", [1])
        inhibit = get(arc, "inhibitTransition", false)
        push!(arcs, Arc(source, target, weight, inhibit))
    end
    
    return PetriNet(places, transitions, arcs, token)
end

# Generate ODE system
function generate_ode_system(net::PetriNet, rates::Dict{String, Float64})
    place_labels = sort(collect(keys(net.places)))
    trans_labels = sort(collect(keys(net.transitions)))
    
    function ode_func!(du, u, p, t)
        for label in place_labels
            du[Symbol(label)] = 0.0
        end
        
        for trans_label in trans_labels
            rate = get(rates, trans_label, 1.0)
            rate == 0.0 && continue
            
            flux = rate
            is_enabled = true
            
            for arc in net.arcs
                if arc.target == trans_label && haskey(net.places, arc.source)
                    weight = isempty(arc.weight) ? 1 : sum(arc.weight)
                    if arc.inhibit_transition
                        if u[Symbol(arc.source)] >= weight
                            is_enabled = false
                            break
                        end
                    else
                        place_val = u[Symbol(arc.source)]
                        if place_val <= 0
                            flux = 0.0
                            is_enabled = false
                            break
                        end
                        flux *= place_val^weight
                    end
                elseif arc.source == trans_label && haskey(net.places, arc.target)
                    if arc.inhibit_transition
                        weight = isempty(arc.weight) ? 1 : sum(arc.weight)
                        if u[Symbol(arc.target)] < weight
                            is_enabled = false
                            break
                        end
                    end
                end
            end
            
            (!is_enabled || flux <= 0) && continue
            
            for arc in net.arcs
                weight = isempty(arc.weight) ? 1 : sum(arc.weight)
                if arc.target == trans_label && haskey(net.places, arc.source) && !arc.inhibit_transition
                    du[Symbol(arc.source)] -= flux * weight
                elseif arc.source == trans_label && haskey(net.places, arc.target) && !arc.inhibit_transition
                    du[Symbol(arc.target)] += flux * weight
                end
            end
        end
    end
    
    return ode_func!, place_labels
end

function set_state(net::PetriNet)
    fields = Dict{Symbol, Float64}()
    for (label, place) in net.places
        fields[Symbol(label)] = isempty(place.initial) ? 0.0 : Float64(sum(place.initial))
    end
    return LVector(; fields...)
end

function solve_ode(net, rates, tstart, tend, dt, abstol, reltol)
    ode_func!, place_labels = generate_ode_system(net, rates)
    u0 = set_state(net)
    tspan = (tstart, tend)
    prob = ODEProblem(ode_func!, u0, tspan)
    sol = solve(prob, Tsit5(), dt=dt, abstol=abstol, reltol=reltol, saveat=dt)
    return sol, place_labels
end

# HTTP handlers
function add_cors_headers(response::HTTP.Response)
    HTTP.setheader(response, "Access-Control-Allow-Origin" => "*")
    HTTP.setheader(response, "Access-Control-Allow-Methods" => "GET, POST, OPTIONS")
    HTTP.setheader(response, "Access-Control-Allow-Headers" => "Content-Type")
    return response
end

function handle_evaluate(req::HTTP.Request)
    try
        body = JSON.parse(String(req.body))
        model_data = body["model"]
        rates_input = body["rates"]
        target_places = get(body, "targetPlaces", collect(keys(get(model_data, "places", Dict()))))
        tstart = get(body, "tstart", 0.0)
        tend = get(body, "tend", 10.0)
        dt = get(body, "dt", 0.01)
        abstol = get(body, "abstol", 1e-6)
        reltol = get(body, "reltol", 1e-3)
        
        net = from_json(model_data)
        rates = Dict{String, Float64}()
        for trans in keys(net.transitions)
            rates[trans] = get(rates_input, trans, 1.0)
        end
        
        sol, _ = solve_ode(net, rates, tstart, tend, dt, abstol, reltol)
        
        results = Dict{String, Any}()
        results["time"] = sol.t
        results["places"] = Dict{String, Vector{Float64}}()
        for place in target_places
            if Symbol(place) in keys(sol.u[1])
                results["places"][place] = [u[Symbol(place)] for u in sol.u]
            end
        end
        
        final_values = Dict{String, Float64}()
        for (label, _) in net.places
            final_values[label] = sol[end][Symbol(label)]
        end
        results["final_values"] = final_values
        
        response = HTTP.Response(200, JSON.json(results))
        HTTP.setheader(response, "Content-Type" => "application/json")
        return add_cors_headers(response)
    catch e
        @error "Evaluation error" exception=(e, catch_backtrace())
        response = HTTP.Response(500, JSON.json(Dict("error" => string(e))))
        HTTP.setheader(response, "Content-Type" => "application/json")
        return add_cors_headers(response)
    end
end

function router(req::HTTP.Request)
    if req.method == "OPTIONS"
        return add_cors_headers(HTTP.Response(200, ""))
    elseif req.method == "POST" && req.target == "/api/evaluate"
        return handle_evaluate(req)
    elseif req.method == "GET" && req.target == "/"
        return HTTP.Response(200, """
            <!DOCTYPE html>
            <html>
            <head><title>Pflow Optimizer Service</title></head>
            <body>
                <h1>Pflow Optimizer Service</h1>
                <p>Julia-based optimization service for Petri nets</p>
                <h2>Endpoints:</h2>
                <ul>
                    <li>POST /api/evaluate - Evaluate scenario with given rates</li>
                </ul>
                <p style="color: green; font-weight: bold;">✓ Service is running</p>
            </body>
            </html>
        """)
    else
        return HTTP.Response(404, "Not found")
    end
end

function start_server(;host::String="0.0.0.0", port::Int=8081)
    println("Starting Pflow Optimizer Service on $host:$port")
    HTTP.serve(router, host, port)
end

end # module
