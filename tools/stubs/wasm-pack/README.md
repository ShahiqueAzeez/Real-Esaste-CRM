# wasm-pack stub

`plivo-browser-sdk` lists `wasm-pack` as a runtime dependency even though it ships a prebuilt
bundle. The real `wasm-pack` package downloads a binary from GitHub in its `postinstall`, which
fails in offline, locked-down and container builds.

The root `package.json` installs this no-op package (`devDependencies.wasm-pack`) and the
`overrides` entry `"wasm-pack": "$wasm-pack"` points every dependent at it.

Remove both entries if a future `plivo-browser-sdk` release drops the dependency.
