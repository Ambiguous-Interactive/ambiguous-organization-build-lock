# Third-party notices

## `ensure-editor.ps1`

`.github/actions/ensure-unity-editor/ensure-editor.ps1` is copied from
`Ambiguous-Interactive/unity-helpers` commit
`76712db791093a9c6b2eccdd9c7bd1b4f1cdb24d`, path
`scripts/unity/ensure-editor.ps1`, with CRLF normalized to LF for this
repository. This copy adds reviewed target/backend profiles for Windows,
Linux, Mac, WebGL, iOS, and Android. The `Steam` profile includes Linux Mono and
IL2CPP modules without Android. The iOS and Mac Mono disk probes follow
layouts reviewed in `Ambiguous-Interactive/unity-helpers` commit
`8c627ab32255a7f931f05bdd33203190e582b267`; the Mac IL2CPP probe applies the
same backend-specific check. Each profile requests and verifies its selected
module groups. The resulting payload SHA-256 digest is
`cf26dfec9b5a88ff425411a89b1002227d0b3f7bd7781ff8ce4d8cb30be4a36f`.

MIT License

Copyright (c) 2023-2026 wallstop

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
