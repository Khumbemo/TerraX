# Runs the R client against the terrax command on TerraX's samples:  Rscript clients/R/terrax/tests/run_tests.R
# (from the repository root, with terrax on PATH or TERRAX_COMMAND set). Checks the web app's answers.
args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", grep("^--file=", args, value = TRUE))))
for (f in list.files(file.path(here, "..", "R"), full.names = TRUE)) source(f)
samples <- normalizePath(file.path(here, "..", "..", "..", "..", "backend", "data", "samples"))
s <- function(name) file.path(samples, name)
ok <- 0
check <- function(cond, what) { if (!isTRUE(cond)) stop("FAILED: ", what, call. = FALSE); ok <<- ok + 1; cat("ok -", what, "\n") }

tools <- terrax_tools()
check(all(c("forest", "landcover", "hydrology", "canopy", "stack") %in% names(tools)), "the tool list")
check("a" %in% names(tools$forest$inputs), "forest's input slots")

r <- terrax_run("forest", list(a = s("forest_ndvi_2016_synthetic.tif"), b = s("forest_ndvi_2024_synthetic.tif")), list(mode = "ndvi"))
check(abs(r$result$result$loss$ha - 184.05) < 1e-9, "forest loss is the web app's 184.05 ha")
check(any(grepl("_forest_change\\.tif$", r$files)), "the class map GeoTIFF is among the files")
check(grepl("184.05 ha", r$markdown, fixed = TRUE), "the report")
printed <- capture.output(print(r))
check(any(grepl("Outputs in", printed)), "print() shows the report and the outputs")

h <- terrax_run("hydrology", list(dem = s("terrain_dem_synthetic.tif")), list(method = "dinf", thresholdKm2 = 0.5))
check(all(c("flow_accumulation_m2.tif", "twi.tif") %in% basename(h$files)), "hydrology rasters")

series <- terrax_run("stack", list(files = sort(Sys.glob(s("series_ndvi_*_synthetic.tif")))), list(index = "ndvi", mapBreaks = TRUE, minDrop = 0.15))
check(abs(series$result$breaks$disturbedHa - 54) < 0.5, "54 ha of disturbance in the series")

lc <- terrax_run("landcover", list(file = s("satellite_4band_synthetic.tif")), list(method = "kmeans", k = 3, bands = I(c(0, 1, 2, 3))))
check(length(lc$result$landcover$stats) == 3, "k-means with a parameter array")

e <- tryCatch(terrax_run("forest", list(a = s("forest_ndvi_2016_synthetic.tif"), b = s("forest_ndvi_2024_synthetic.tif")), list(lossThreshold = 0.3)), error = function(e) conditionMessage(e))
check(grepl("loss threshold", e), "TerraX's own message becomes the R error")
e <- tryCatch(terrax_run("forest", list(a = "/no/such.tif")), error = function(e) conditionMessage(e))
check(grepl("no file", e), "a missing input file")

if (requireNamespace("terra", quietly = TRUE)) {
  cm <- terra::rast(grep("_forest_change\\.tif$", r$files, value = TRUE))
  check(sum(terra::values(cm) == 2, na.rm = TRUE) == r$result$result$loss$pixels, "terra reads the class map")
}
cat(ok, "checks passed\n")
