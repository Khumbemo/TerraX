\name{terrax}
\alias{terrax}
\alias{terrax_run}
\alias{terrax_tools}
\alias{terrax_command}
\alias{terrax_boundary_file}
\alias{print.terrax_result}
\title{TerraX earth-observation tools from R}
\description{
Runs TerraX's tools on local files through the \code{terrax} command: the same code and results as the TerraX web
app. Each run writes \code{result.json}, \code{report.md} and its output files (GeoTIFF class maps with colour tables,
slope, flow accumulation, wetness; GeoJSON polygons, streams, contours, tree tops; CSV) to a folder.
}
\usage{
terrax_tools()
terrax_run(tool, inputs = list(), params = list(), out = tempfile("terrax-"), boundary = NULL)
terrax_command()
terrax_boundary_file(x)
\method{print}{terrax_result}(x, ...)
}
\arguments{
\item{tool}{A tool name, one of \code{names(terrax_tools())}.}
\item{inputs}{A named list: input slot to file path, or a vector of paths for slots that take several files.}
\item{params}{A named list of parameters. Length-one vectors become JSON scalars; wrap one-element arrays in \code{I()}.}
\item{out}{The output folder.}
\item{boundary}{Polygons that limit the analysis: a file path, or an \code{sf} object.}
\item{x}{A boundary (path or \code{sf}), or a result to print.}
\item{...}{Ignored.}
}
\value{
\code{terrax_run} returns a \code{terrax_result}: \code{result} (the tool's result as a list), \code{markdown} (the
report), \code{out} (the folder) and \code{files} (full paths of the outputs). \code{terrax_tools} returns each tool's
summary, input slots and main parameters.
}
\details{
The command is \code{getOption("terrax.command")}, else the \code{TERRAX_COMMAND} environment variable, else
\code{terrax} on the PATH. Install it with \code{pip install -e backend} from the TerraX repository.
}
\examples{
\dontrun{
r <- terrax_run("forest", list(a = "ndvi_2016.tif", b = "ndvi_2024.tif"), list(mode = "ndvi"))
r$result$result$loss$ha
classes <- terra::rast(grep("_forest_change.tif$", r$files, value = TRUE))
}
}
