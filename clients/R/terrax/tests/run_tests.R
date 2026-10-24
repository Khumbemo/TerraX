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

# A Python built as a shared library outside /usr (as in CI): R puts the system's library folder first, so the
# command must get its Python's own lib folder back in front. A stand-in Python insists on that, then runs terrax.
if (.Platform$OS.type == "unix" && Sys.info()[["sysname"]] != "Darwin") {
  prefix <- file.path(tempfile("py-"), "x64")
  dir.create(file.path(prefix, "bin"), recursive = TRUE); dir.create(file.path(prefix, "lib"))
  file.create(file.path(prefix, "lib", "libpython3.12.so.1.0"))
  real <- Sys.which(terrax_command()[1])
  shebang <- readLines(real, n = 1L)
  py <- file.path(prefix, "bin", "python3.12")
  writeLines(c("#!/bin/sh", sprintf('case "$LD_LIBRARY_PATH" in "%s/lib"*) ;; *) echo "terrax: LD_LIBRARY_PATH is $LD_LIBRARY_PATH" >&2; exit 1;; esac', prefix),
               sprintf('exec %s "$@"', sub("^#!", "", shebang))), py)
  wrapped <- file.path(prefix, "bin", "terrax")
  writeLines(c(paste0("#!", py), readLines(real)[-1]), wrapped)
  Sys.chmod(c(py, wrapped), "755")
  old <- options(terrax.command = wrapped)
  check("forest" %in% names(terrax_tools()), "a shared-library Python gets its own lib folder first")
  options(old)
}

if (requireNamespace("terra", quietly = TRUE)) {
  cm <- terra::rast(grep("_forest_change\\.tif$", r$files, value = TRUE))
  check(sum(terra::values(cm) == 2, na.rm = TRUE) == r$result$result$loss$pixels, "terra reads the class map")
}
cat(ok, "checks passed\n")
