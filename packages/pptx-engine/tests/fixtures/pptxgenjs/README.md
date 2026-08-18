# PptxGenJS interoperability fixtures

These PPTX files were generated once with PptxGenJS 4.0.1 by `generate.mjs`.
They preserve an external producer's OOXML shape without keeping PptxGenJS and
its unpatched `image-size` dependency in the test toolchain. Tests may replace
only the `__TEXT__` token in the template slide XML.

PptxGenJS is MIT licensed: https://github.com/gitbrent/PptxGenJS
