# Sol high vs Luna max — identical office task comparison

Verified: 2026-08-09 (Asia/Seoul)

## Task and timing

Both agents received the same source workbook and the same requirements: rebuild
an exact three-sheet investment workbook, then create an exact three-slide
investment-committee deck and render the dashboard plus all slides.

| Setting              | Artifact-ready wall time | Final state                                                      |
| -------------------- | -----------------------: | ---------------------------------------------------------------- |
| `gpt-5.6-sol / high` |                  13m 45s | completed normally                                               |
| `gpt-5.6-luna / max` |                  18m 29s | artifacts ready; agent remained running until stopped at 25m 34s |

## Independent result

| Check                               | Sol high                        | Luna max                                                             |
| ----------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| Same 10 source initiatives          | PASS                            | PASS                                                                 |
| Sheets                              | 3                               | 3                                                                    |
| Formula / cross-sheet formula count | 135 / 66                        | 120 / 59                                                             |
| Frozen panes on all three sheets    | PASS                            | FAIL (none)                                                          |
| Core values                         | PASS                            | PASS                                                                 |
| PPT slides                          | 3                               | 3                                                                    |
| PPT construction                    | 3 full-slide images             | 89 editable shapes, 1 chart                                          |
| Visual result                       | stronger hierarchy and contrast | strong overall; small chart labels and risk-number wraps need polish |

Both workbooks independently recomputed to total investment ₩1,152.00M,
expected ARR ₩1,175.85M, Base ₩23.85M, Downside −₩618.12M, and Upside
₩608.22M. Both decks use the same top-three recommendation and derived values.

Verdict: Sol/high won visual polish, speed, and strict workbook completeness.
Luna/max won native PowerPoint editability but missed frozen panes and did not
self-terminate promptly after producing its artifacts. For an executive PDF or
read-only deck choose Sol/high; for a deck that must be edited in PowerPoint,
choose Luna/max and add a final QA pass.

## Reproduction

```sh
cd /Users/jyb-m3max/Desktop/codex/genoffice
/Users/jyb-m3max/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  qa-artifacts/model-comparison/verify_outputs.py \
  qa-artifacts/model-comparison/sol-high/sol-high-portfolio.xlsx \
  qa-artifacts/model-comparison/sol-high/sol-high-investment-committee.pptx \
  qa-artifacts/model-comparison/luna-max/luna-max-portfolio.xlsx \
  qa-artifacts/model-comparison/luna-max/luna-max-investment-committee.pptx
```

Machine-readable evidence is in `independent-verification.json`.
