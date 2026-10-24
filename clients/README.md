# TerraX from R and Julia

Both clients run the `terrax` command, so they use TerraX's own Python code and give the same results as the web app.
They return each tool's result, its report and the output files. Install the command first, in any Python 3.11 or
newer environment: `pip install -e backend`. Then put it on the PATH, or set `TERRAX_COMMAND` (in R, also
`options(terrax.command = …)`).

## R (`clients/R/terrax`)

```r
install.packages("jsonlite")                     # its one dependency; terra and sf are optional
install.packages("clients/R/terrax", repos = NULL, type = "source")
library(terrax)

names(terrax_tools())                            # the tools, their inputs and main parameters
r <- terrax_run("forest", list(a = "ndvi_2016.tif", b = "ndvi_2024.tif"), list(mode = "ndvi", mmuHa = 0.5))
r$result$result$loss$ha                          # hectares of loss
r                                                # prints the report and lists the outputs
classes <- terra::rast(grep("_forest_change.tif$", r$files, value = TRUE))
loss <- sf::st_read(grep("_loss_patches.geojson$", r$files, value = TRUE))

terrax_run("stack", list(files = Sys.glob("s2_*.tif")), list(index = "ndvi", mapBreaks = TRUE), boundary = my_sf_polygon)
```

Parameters are a named list, converted to JSON: length-one vectors become scalars, so wrap a one-element array in
`I()` (`list(bands = I(0))`). A tool that refuses its inputs raises an R error with TerraX's own message.
Tests: `Rscript clients/R/terrax/tests/run_tests.R`.

## Julia (`clients/julia/TerraX`)

```julia
using Pkg; Pkg.develop(path = "clients/julia/TerraX")
using TerraX

r = terrax_run("hydrology"; inputs = Dict("dem" => "dem.tif"), params = Dict("method" => "dinf", "thresholdKm2" => 0.5))
r.result["flow"]["maxOrder"]
r.files                                          # flow_accumulation_m2.tif, twi.tif, streams GeoJSON, …
```

Results are plain `Dict`s and `Vector`s. The outputs open with Rasters.jl, ArchGDAL.jl or GeoJSON.jl.
Tests: `julia --project=clients/julia/TerraX -e 'using Pkg; Pkg.test()'`.

## Against a TerraX server instead

The same tools are behind the web API, so any language with HTTP can run them on a TerraX server:

1. Upload each file: `POST /api/files`, a multipart `file` field. It returns `{"id": …}`.
2. Start the job: `POST /api/jobs` with `{"tool": "forest", "inputs": {"a": id1, "b": id2}, "params": {…}}`.
3. Poll `GET /api/jobs/{id}` until `state` is `done`, then read `result`.

Send `Authorization: Bearer <token>` on servers with accounts (see "Accounts, access and data" in the main README).
