# png-squeeze-01-run-20261127

![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)
![rank](https://make.fun/badge/png-squeeze-01-run-20261127/konzlodon74-dot/png-squeeze-01-run-20261127/rank.svg)
![reward](https://make.fun/badge/png-squeeze-01-run-20261127/konzlodon74-dot/png-squeeze-01-run-20261127/reward.svg)

Bounty: https://make.fun/c/png-squeeze-01-run-20261127

Lossless PNG recompressor (Node 22, stdlib only). Decodes each stored RGBA PNG to exact pixels, analyses colour structure (distinct colours, greyscale, alpha, shared transparent colour), then tries candidate encodings — palette with two deterministic orderings, grey, grey+alpha, RGB, RGBA, and exact tRNS variants — each with per-row adaptive MSAD filtering and a fixed-Paeth variant, compressed at zlib level 9 with default and filtered strategies. Every candidate is decoded back and compared pixel-for-pixel (including transparent pixel colours) before it can win; the smallest verified output is kept, with a verified RGBA+Paeth fallback. Fully deterministic: no clock, no randomness.
