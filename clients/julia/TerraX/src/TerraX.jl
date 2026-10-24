"""
    TerraX

TerraX's earth-observation tools from Julia: each call runs the `terrax` command (TerraX's Python tools on local
files, the same code and results as the web app) and reads what it wrote. Outputs are ordinary GeoTIFF and GeoJSON
files, for Rasters.jl, ArchGDAL.jl or GeoJSON.jl.

    using TerraX
    r = terrax_run("forest"; inputs = Dict("a" => "ndvi_2016.tif", "b" => "ndvi_2024.tif"), params = Dict("mode" => "ndvi"))
    r.result["result"]["loss"]["ha"]

The command is the `TERRAX_COMMAND` environment variable (a path, or a command line such as
`/opt/terrax/bin/python -m terrax`), else `terrax` on the PATH.
"""
module TerraX

using JSON3

export terrax_run, terrax_tools, terrax_command, TerraxResult

"""A tool's run: its result (the tool's JSON as Dicts and Vectors), the report, the output folder and files."""
struct TerraxResult
    tool::String
    result::Dict{String,Any}
    markdown::String
    out::String
    files::Vector{String}
end

Base.show(io::IO, ::MIME"text/plain", r::TerraxResult) = print(io, r.markdown, "\n\nOutputs in ", r.out, ": ", join(basename.(r.files), ", "))
Base.show(io::IO, ::MIME"text/markdown", r::TerraxResult) = print(io, r.markdown)

"""The terrax command as a `Cmd`."""
function terrax_command()::Cmd
    configured = strip(get(ENV, "TERRAX_COMMAND", ""))
    if isempty(configured)
        found = Sys.which("terrax")
        found === nothing && error("The terrax command was not found. Install TerraX (pip install -e backend from the TerraX repository) " *
                                   "and put it on PATH, or set ENV[\"TERRAX_COMMAND\"].")
        return Cmd([found])
    end
    return Cmd(String.(split(configured)))
end

native(x::JSON3.Object) = Dict{String,Any}(String(k) => native(v) for (k, v) in pairs(x))
native(x::JSON3.Array) = Any[native(v) for v in x]
native(x) = x

function exec(args::Vector{String})::String
    out, err = IOBuffer(), IOBuffer()
    proc = run(pipeline(ignorestatus(`$(terrax_command()) $args`); stdout = out, stderr = err))
    msg = String(take!(err))
    if !success(proc)
        reasons = filter(l -> startswith(l, "terrax: "), split(msg, '\n'))
        error(isempty(reasons) ? "terrax exited with $(proc.exitcode)\n$msg" : replace(String(last(reasons)), "terrax: " => ""; count = 1))
    end
    return String(take!(out))
end

"""The tools that run on local files: each tool's summary, input slots and main parameters."""
terrax_tools()::Dict{String,Any} = native(JSON3.read(exec(["tools", "--json"])))["tools"]

"""
    terrax_run(tool; inputs = Dict(), params = Dict(), out = mktempdir(), boundary = nothing) -> TerraxResult

Runs one TerraX tool on local files. `inputs` maps input slots to a file path, or a vector of paths for slots that take
several files (`"files"` for `"stack"`); `params` are the same JSON the web app sends; `boundary` is a GeoJSON, KML or
zipped shapefile of polygons that limits the analysis. Throws with TerraX's own message when a tool refuses its inputs.
"""
function terrax_run(tool::AbstractString; inputs = Dict{String,Any}(), params = Dict{String,Any}(), out::AbstractString = mktempdir(), boundary = nothing)::TerraxResult
    mkpath(out)
    out = abspath(out)
    args = String["run", String(tool), "-o", out]
    for (slot, value) in pairs(inputs)
        value === nothing && continue
        paths = value isa AbstractVector ? collect(value) : [value]
        isempty(paths) && continue
        for p in paths
            isfile(string(p)) || error("$(slot): no file $(p)")
        end
        push!(args, "-i", string(slot, "=", join(abspath.(string.(paths)), ",")))
    end
    pfile = tempname() * ".json"
    write(pfile, isempty(params) ? "{}" : JSON3.write(params))
    push!(args, "--params", pfile)
    boundary === nothing || push!(args, "--boundary", abspath(string(boundary)))
    try
        exec(args)
    finally
        rm(pfile; force = true)
    end
    result = native(JSON3.read(read(joinpath(out, "result.json"), String)))
    markdown = read(joinpath(out, "report.md"), String)
    files = [joinpath(out, f) for f in readdir(out) if !(f in ("result.json", "report.md"))]
    return TerraxResult(String(tool), result, markdown, out, files)
end

end
