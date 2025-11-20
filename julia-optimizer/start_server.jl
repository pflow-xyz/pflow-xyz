#!/usr/bin/env julia

"""
Startup script for Pflow Optimizer Service

Usage:
    julia start_server.jl [--port PORT] [--host HOST]

Options:
    --port PORT    Port to listen on (default: 8081)
    --host HOST    Host to bind to (default: 0.0.0.0)
"""

using Pkg

# Activate the project environment
Pkg.activate(@__DIR__)

# Load the module
using PflowOptimizer

# Parse command line arguments
port = 8081
host = "0.0.0.0"

for i in 1:length(ARGS)
    if ARGS[i] == "--port" && i < length(ARGS)
        port = parse(Int, ARGS[i+1])
    elseif ARGS[i] == "--host" && i < length(ARGS)
        host = ARGS[i+1]
    elseif ARGS[i] == "--help" || ARGS[i] == "-h"
        println("""
        Pflow Optimizer Service
        
        Usage:
            julia start_server.jl [OPTIONS]
        
        Options:
            --port PORT    Port to listen on (default: 8081)
            --host HOST    Host to bind to (default: 0.0.0.0)
            --help, -h     Show this help message
        """)
        exit(0)
    end
end

# Start the server
println()
println("=" ^ 70)
println(" Pflow Optimizer Service")
println("=" ^ 70)
println()
println(" A Julia-based webservice for Petri net optimization and evaluation")
println()
println(" Configuration:")
println("   Host: $host")
println("   Port: $port")
println("   URL:  http://$(host == "0.0.0.0" ? "localhost" : host):$port")
println()
println(" Press Ctrl+C to stop the server")
println("=" ^ 70)
println()

PflowOptimizer.start_server(host=host, port=port)
