---
title: TerraX
emoji: 🌍
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
short_description: Earth-observation workbench for forest, land and climate
---

# TerraX

Forest loss, carbon, land survey, residential plot change, climate trends,
satellite indices, land cover, terrain and photo analysis, computed by a
Python server (rasterio, GeoPandas, scikit-learn) with MapLibre maps.

This Space runs the one-container build of
[github.com/Khumbemo/TerraX](https://github.com/Khumbemo/TerraX): the API
serves the web app and runs analyses on background threads. Uploads and
results are deleted after 24 hours, and the Space's disk is reset when it
restarts. Add a `GEMINI_API_KEY` secret in the Space settings to enable the AI
assistants; without it the built-in assistant answers.
