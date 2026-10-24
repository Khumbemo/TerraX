"""TerraX Processing: TerraX's tools as QGIS Processing algorithms (they call the ``terrax`` command)."""


def classFactory(iface):
    from .plugin import TerraxPlugin

    return TerraxPlugin(iface)
