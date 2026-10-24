# The Julia client against the terrax command on TerraX's samples (terrax on PATH or TERRAX_COMMAND set):
#     julia --project=clients/julia/TerraX -e 'using Pkg; Pkg.test()'
using Test
using TerraX

const SAMPLES = normpath(joinpath(@__DIR__, "..", "..", "..", "..", "backend", "data", "samples"))
s(name) = joinpath(SAMPLES, name)

@testset "TerraX" begin
    tools = terrax_tools()
    @test all(t -> haskey(tools, t), ["forest", "landcover", "hydrology", "canopy", "stack"])
    @test haskey(tools["forest"]["inputs"], "a")

    r = terrax_run("forest"; inputs = Dict("a" => s("forest_ndvi_2016_synthetic.tif"), "b" => s("forest_ndvi_2024_synthetic.tif")), params = Dict("mode" => "ndvi"))
    @test r.result["result"]["loss"]["ha"] ≈ 184.05  # the web app's answer
    @test any(f -> endswith(f, "_forest_change.tif"), r.files)
    @test occursin("184.05 ha", r.markdown)
    @test occursin("Outputs in", sprint(show, MIME("text/plain"), r))

    h = terrax_run("hydrology"; inputs = (dem = s("terrain_dem_synthetic.tif"),), params = Dict("method" => "dinf", "thresholdKm2" => 0.5))
    @test issubset(["flow_accumulation_m2.tif", "twi.tif"], basename.(h.files))

    files = sort(filter(f -> startswith(f, "series_ndvi_"), readdir(SAMPLES)))
    series = terrax_run("stack"; inputs = Dict("files" => s.(files)), params = Dict("index" => "ndvi", "mapBreaks" => true, "minDrop" => 0.15))
    @test isapprox(series.result["breaks"]["disturbedHa"], 54; atol = 0.5)

    lc = terrax_run("landcover"; inputs = Dict("file" => s("satellite_4band_synthetic.tif")), params = Dict("method" => "kmeans", "k" => 3, "bands" => [0, 1, 2, 3]))
    @test length(lc.result["landcover"]["stats"]) == 3

    err = try
        terrax_run("forest"; inputs = Dict("a" => s("forest_ndvi_2016_synthetic.tif"), "b" => s("forest_ndvi_2024_synthetic.tif")), params = Dict("lossThreshold" => 0.3))
        ""
    catch e
        sprint(showerror, e)
    end
    @test occursin("loss threshold", err)  # TerraX's own message
    @test_throws ErrorException terrax_run("forest"; inputs = Dict("a" => "/no/such.tif"))
end
