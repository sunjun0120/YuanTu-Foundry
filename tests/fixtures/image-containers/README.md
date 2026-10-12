JPEG fixture `baseline.jpg` is `testorig.jpg` from the official libjpeg-turbo 3.1.3
reference test images:
https://github.com/libjpeg-turbo/libjpeg-turbo/tree/3.1.3/testimages
They are distributed under the project's IJG license:
https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.1.3/LICENSE.md

`progressive.jpg` and `restarts.jpg` are `progressive3.jpg` and `restarts.jpg`
from image-rs/jpeg-decoder's reference corpus at commit
`eb2d7c0f6a2d0298aba7a7f8b9ca1440353e8f8c`, distributed under MIT/Apache-2.0:
https://github.com/image-rs/jpeg-decoder/tree/eb2d7c0f6a2d0298aba7a7f8b9ca1440353e8f8c/tests/reftest/images
https://github.com/image-rs/jpeg-decoder/blob/eb2d7c0f6a2d0298aba7a7f8b9ca1440353e8f8c/LICENSE-MIT

The WebP fixtures were generated locally with Chromium 1243 using a 2 by 2 canvas,
red pixels, and `canvas.toDataURL('image/webp', quality)`. `vp8.webp` uses quality
0.8, `vp8l.webp` uses quality 1, and `vp8x.webp` clears one pixel before encoding
at quality 0.8. Chromium includes a VP8X header and ICCP chunk in all three.
Tests extract the trusted codec chunks to exercise the simple containers too.
`vp8l-alpha.webp` uses the same transparent canvas at quality 1. Its regression
clears the VP8L alpha hint without changing the encoded pixels.
