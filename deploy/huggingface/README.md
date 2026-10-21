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

Each browser only sees its own uploads and results. Accounts (history and
projects) work too, but the built-in SQLite database is on the same disk, so
they reset with it: for lasting accounts add a `DATABASE_URL` secret pointing at
PostgreSQL (`postgresql+psycopg://user:password@host/db`). Add
`TERRAX_AUTH=required` and `TERRAX_ADMIN_EMAIL` / `TERRAX_ADMIN_PASSWORD`
secrets to make everyone sign in. Because Spaces show the app inside a frame on
huggingface.co, TerraX uses partitioned `SameSite=None` cookies there
(detected from `SPACE_ID`).
