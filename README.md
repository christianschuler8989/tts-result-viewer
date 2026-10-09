# TTS result viewer

Static web page for listening to the outputs of text-to-speech systems side by side. The text that was synthesised sits at the top, every row below it is one audio file (the original recording, the cloning reference, one row per system).

The page is served through GitHub Pages from the root of this repository. For a local look, run `python3 -m http.server` in this directory and open the address it prints. Opening `index.html` as a file does not work, browsers block the loading of the data there.

## Result sets

| Result set | Title | Built | Groups | Systems | Items | Audio files |
|---|---|---|---|---|---|---|
| `collab_2026_10` | collab_2026_10 | 2026-10-09 | 2 | 12 | 360 | 4677 |

## Where the files come from

Every file listed in `.site_manifest.json` is written by `result_viewer/publish_site.py` of the TTS pipeline and is replaced by the next publication. Changes to the page or to the data are made in the pipeline. Files that are not listed there are left alone by the script.
