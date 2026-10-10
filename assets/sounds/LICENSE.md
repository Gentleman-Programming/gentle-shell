# Original notification tones

`success.wav`, `error.wav`, and `attention.wav` are original synthetic sine tones,
created for Gentle AI in 2026. No recording, sample library, audio API, or third-party
composition was used. Mono PCM, 16-bit, 22050 Hz; amplitude 4000/32768, short fades.
No platform listening verification has been performed; these are generated assets,
not evidence of working playback. Linux/macOS adapters require manual verification;
Windows playback is intentionally unavailable pending a safe native adapter.

## Reproduction recipe (Python 3 standard library)

Run from repository root. This reproduces only the three WAV assets:

```python
import math, struct, wave
from pathlib import Path
root = Path('assets/sounds')
root.mkdir(parents=True, exist_ok=True)
for name, frequencies in {'success': (660, 880), 'error': (330, 220), 'attention': (880, 880, 880)}.items():
    samples = []
    for frequency in frequencies:
        count = 2646
        for i in range(count):
            envelope = min(1, i / 220, (count - 1 - i) / 440)
            samples.append(round(4000 * envelope * math.sin(2 * math.pi * frequency * i / 22050)))
        samples.extend([0] * 661)
    with wave.open(str(root / (name + '.wav')), 'wb') as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(22050)
        out.writeframes(struct.pack('<' + 'h' * len(samples), *samples))
```

## MIT License

Copyright (c) 2026 Gentle AI contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
