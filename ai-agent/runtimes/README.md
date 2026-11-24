# Linux VM image

`alpine.iso` is the unmodified official **Alpine Linux 3.24.4 "virt" x86 (32-bit) ISO**
(`alpine-virt-3.24.4-x86.iso`, SHA-256 in `alpine.json`) from
https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86/. It ships with the app because the Alpine mirror does not
allow downloads from web pages (no CORS headers).

Ai Agent installs it into the Hub (`Hub/runtimes/linux/`) automatically the first time the app opens, verifies the
checksum, and runs it in the v86 emulator (type `linux` in the Code tab terminal).

Alpine Linux and its packages are free software under their own licenses (mostly GPL, MIT and BSD). Source code is
available from https://alpinelinux.org/ and https://gitlab.alpinelinux.org/alpine/aports.

To update: download the new `alpine-virt-*-x86.iso`, save it here as `alpine.iso`, and update `file`, `version` and
`sha256` in `alpine.json`.
