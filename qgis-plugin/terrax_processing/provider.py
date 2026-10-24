"""The TerraX Processing provider: its algorithms and the setting that locates the ``terrax`` command."""

import os

from qgis.core import QgsProcessingProvider
from qgis.PyQt.QtGui import QIcon

from . import algorithms
from .runner import SETTING


class TerraxProvider(QgsProcessingProvider):
    def id(self):
        return "terrax"

    def name(self):
        return "TerraX"

    def longName(self):
        return "TerraX earth-observation tools"

    def icon(self):
        return QIcon(os.path.join(os.path.dirname(__file__), "icon.svg"))

    def load(self):
        from processing.core.ProcessingConfig import ProcessingConfig, Setting

        ProcessingConfig.settingIcons[self.name()] = self.icon()
        ProcessingConfig.addSetting(Setting(self.name(), SETTING, "terrax command (path, or e.g. /opt/terrax/bin/python -m terrax); empty: terrax on PATH", ""))
        ProcessingConfig.readSettings()
        self.refreshAlgorithms()
        return True

    def unload(self):
        from processing.core.ProcessingConfig import ProcessingConfig

        ProcessingConfig.removeSetting(SETTING)

    def loadAlgorithms(self):
        for cls in algorithms.ALGORITHMS:
            self.addAlgorithm(cls())
