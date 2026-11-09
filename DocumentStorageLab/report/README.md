# Report data and figures

The Word report uses the dated runs listed in `evidence-selection.json`. The benchmark keeps one record per request; the report tables aggregate the three runs for each workload. The figures and resource summaries are included for reference.

To regenerate the report from the saved data, use Python 3.12 from the lab directory:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r report/requirements.txt
.venv/bin/python report/build_report.py
```

The builder writes the Word file beside the lab directory. It reads saved measurements and does not start or stop containers.
