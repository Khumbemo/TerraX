# TerraX from R: each function runs the `terrax` command (TerraX's Python tools on local files, the same code and
# results as the web app) and reads what it wrote. Outputs are ordinary GeoTIFF and GeoJSON files: open them with
# terra::rast() and sf::st_read().

#' The terrax command: option "terrax.command", else the TERRAX_COMMAND environment variable, else `terrax` on PATH.
#' A value may carry arguments, e.g. "/opt/terrax/bin/python -m terrax".
terrax_command <- function() {
  cmd <- getOption("terrax.command", Sys.getenv("TERRAX_COMMAND", ""))
  if (!nzchar(cmd)) cmd <- Sys.which("terrax")
  if (!nzchar(cmd)) {
    stop("The terrax command was not found. Install TerraX (pip install -e backend from the TerraX repository) ",
         "and put it on PATH, or set options(terrax.command = \"/path/to/terrax\").", call. = FALSE)
  }
  strsplit(cmd, " ", fixed = TRUE)[[1]]
}

.terrax_exec <- function(args) {
  cmd <- terrax_command()
  err <- tempfile(fileext = ".log")
  on.exit(unlink(err), add = TRUE)
  out <- suppressWarnings(system2(cmd[1], c(cmd[-1], shQuote(args)), stdout = TRUE, stderr = err))
  status <- attr(out, "status")
  msg <- if (file.exists(err)) readLines(err, warn = FALSE) else character()
  if (!is.null(status) && status != 0) {
    reason <- grep("^terrax: ", msg, value = TRUE)
    stop(if (length(reason)) sub("^terrax: ", "", tail(reason, 1)) else paste(c(sprintf("terrax exited with %s", status), msg), collapse = "\n"), call. = FALSE)
  }
  out
}

#' The tools that run on local files: their summaries, input slots and main parameters (a list by tool name).
terrax_tools <- function() {
  jsonlite::fromJSON(paste(.terrax_exec(c("tools", "--json")), collapse = "\n"), simplifyVector = FALSE)$tools
}

#' A boundary file (GeoJSON, KML or zipped shapefile of polygons) for terrax_run(boundary = ...); an sf object is
#' written to a temporary GeoJSON first (in WGS84, as TerraX reads GeoJSON).
terrax_boundary_file <- function(x) {
  if (is.character(x)) return(normalizePath(x, mustWork = TRUE))
  if (!requireNamespace("sf", quietly = TRUE)) stop("An sf boundary needs the sf package; or pass a file path.", call. = FALSE)
  path <- tempfile(fileext = ".geojson")
  sf::st_write(sf::st_transform(x, 4326), path, quiet = TRUE)
  path
}

#' Runs one TerraX tool on local files.
#'
#' @param tool A tool name (see names(terrax_tools())).
#' @param inputs A named list: input slot -> file path, or a vector of paths for slots that take several files
#'   (e.g. list(files = c("s2_2019.tif", ...)) for "stack").
#' @param params A named list of parameters (the same JSON the web app sends). Length-one vectors become JSON
#'   scalars; wrap a one-element array in I(), e.g. list(bands = I(0)).
#' @param out The folder for result.json, report.md and the output files (default: a new temporary folder).
#' @param boundary Polygons that limit the analysis: a file path or an sf object.
#' @return A "terrax_result": result (the tool's result as a list), markdown (the report), out (the folder) and files
#'   (full paths of the output files).
terrax_run <- function(tool, inputs = list(), params = list(), out = tempfile("terrax-"), boundary = NULL) {
  stopifnot(is.character(tool), length(tool) == 1, is.list(inputs), is.list(params))
  dir.create(out, showWarnings = FALSE, recursive = TRUE)
  out <- normalizePath(out)
  args <- c("run", tool, "-o", out)
  for (slot in names(inputs)) {
    paths <- inputs[[slot]]
    if (is.null(paths) || !length(paths)) next
    missing <- paths[!file.exists(paths)]
    if (length(missing)) stop(sprintf("%s: no file %s", slot, missing[1]), call. = FALSE)
    args <- c(args, "-i", paste0(slot, "=", paste(normalizePath(paths), collapse = ",")))
  }
  pfile <- tempfile(fileext = ".json")
  on.exit(unlink(pfile), add = TRUE)
  writeLines(if (length(params)) jsonlite::toJSON(params, auto_unbox = TRUE, digits = NA, null = "null") else "{}", pfile)
  args <- c(args, "--params", pfile)
  if (!is.null(boundary)) args <- c(args, "--boundary", terrax_boundary_file(boundary))
  .terrax_exec(args)
  result <- jsonlite::read_json(file.path(out, "result.json"), simplifyVector = FALSE)
  md <- paste(readLines(file.path(out, "report.md"), warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  files <- setdiff(list.files(out, full.names = TRUE), file.path(out, c("result.json", "report.md")))
  structure(list(tool = tool, result = result, markdown = md, out = out, files = files), class = "terrax_result")
}

print.terrax_result <- function(x, ...) {
  cat(x$markdown, "\n\nOutputs in ", x$out, ": ", paste(basename(x$files), collapse = ", "), "\n", sep = "")
  invisible(x)
}
