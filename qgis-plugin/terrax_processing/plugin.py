"""Registers the TerraX provider with QGIS Processing."""

from qgis.core import QgsApplication

from .provider import TerraxProvider


class TerraxPlugin:
    def __init__(self, iface=None):
        self.iface = iface
        self.provider = None

    def initProcessing(self):
        self.provider = TerraxProvider()
        QgsApplication.processingRegistry().addProvider(self.provider)

    def initGui(self):
        self.initProcessing()

    def unload(self):
        if self.provider is not None:
            QgsApplication.processingRegistry().removeProvider(self.provider)
            self.provider = None
