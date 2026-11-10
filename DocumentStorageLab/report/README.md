# Report data

`evidence-selection.json` identifies the runs used in the Word report. To rebuild it from this directory's parent, use Python 3.12:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r report/requirements.txt
.venv/bin/python report/build_report.py
```

The report is written beside `DocumentStorageLab`.
