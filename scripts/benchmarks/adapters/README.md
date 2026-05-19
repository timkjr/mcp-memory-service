# Benchmark Adapters

Run LongMemEval/LoCoMo against alternative memory tools.

## Tested
- **mem0** (cloud API) — ✅ working (2026-05-18)

## Usage

Run the standalone mem0 benchmark script directly (the main `benchmark_longmemeval.py`
does not yet have `--adapter` integration):

```bash
export MEM0_API_KEY=your_key
cd scripts/benchmarks/adapters
python run_longmemeval_mem0.py --limit 5
```
